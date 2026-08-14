# Changelog

All notable changes to Cellexia Reviews are documented here. The version number is read from
`package.json` and stamped into the release ZIP built by `npm run package`
(`dist/cellexia-reviews-v<version>.zip`).

## 1.33.0 — 2026-08-14

### Changed — card badge placement: two polished choices (SPEC-1.33.md)

Merchant feedback on the freshly deployed numeric rating: sitting flush
under the price looked cramped. Both remedies now ship through the app
embed's existing "Card badge position" setting — pick either in the theme
editor, no redeploy needed after this build:

- **Under the price** (the current setting) now leaves a small gap between
  the price and the rating line. The gap only applies when the badge really
  sits under a price — when a card has no price and the badge falls back to
  the tagline or title, spacing stays as before.
- **Under the tagline** places the rating above the price (title → tagline
  → rating → price, the Amazon card order) — unchanged behavior, called out
  here as the alternative the merchant previewed.

No new settings, no server, scope, locale or schema changes; the Badge
doctor's deployed-extension check already reports which position is active.

## 1.32.0 — 2026-08-14

### Fixed — the numeric star rating now shows on every card badge (SPEC-1.32.md)

This was the original report. From the merchant's first message ("the star
rating is not visible … only the visible stars and number of reviews") the
missing piece was the numeric rating VALUE on card badges — not missing
badges. The card badge has never rendered the number — by design, on any
surface, for anyone: stars + "(count)" only. The product-page title badge
shows it and the star-rating block shows it; cards were the one surface
without it. The 1.31 fetch-layer fixes address real defects and stand — but
they were not what the merchant was reporting.

- **Card badges now read number → stars → (count)** — the same anatomy as the
  product page's title badge — everywhere the "stars and review count" style renders:
  collection, home-page and search cards, and cart items. The number is one
  decimal, produced by the exact same locale formatter as the product page's
  average, so the two can never disagree. The "stars only" style stays
  literally stars-only, and screen readers hear the rating exactly once (the
  stars already announce it; the visible number is not read out again).
- **Nothing to re-save.** The fix depends on no theme-editor setting —
  existing installs show the number as soon as the new build is deployed.

### Added — the "Badge doctor" tab (admin)

A new nav tab that verifies every link of the card-star pipeline from inside
the admin, step by step, each step PASS / WARN / FAIL with a plain-language
"what this means / what to do" line: a before/after preview of the card badge
built from your own top-reviewed product (so the 1.32 fix is unmissable); a
per-product review-data table (published counts, averages, and every product
handle observed on review rows — a product whose reviews are all unpublished
is flagged); an API dry-run that feeds handles you type to the real badge
lookup and shows, per handle, which path resolved it (cache / review rows /
Admin API / storefront lookup / negative cache / unresolved) plus the exact
JSON the storefront would receive; the live/markets gating state (naming the
by-design 403 and the exact Dashboard toggle to flip); the badge rate-limit
configuration as actually deployed; and a button-invoked deployed-extension
check that fetches your own storefront and verifies the build shoppers
actually receive renders the numeric rating — telling you to redeploy when it
predates 1.32.

- Technical: the dry-run needed a trace hook in the badge service — an
  optional, append-only parameter (default off, zero behavior change for
  existing callers; the 1.31 suite runs untouched and green). New dev-test
  suite `scripts/dev-tests/badge-doctor.test.mjs` (37 checks). The card-badge
  diff is ~350 bytes and stays under the existing 145 KiB extension asset
  gate (not raised). No settings changes, no new scopes, no migrations, no
  locale-file changes (the Badge doctor is admin-side English like every
  other admin page).
- Technical (adversarial-review hardening on the Badge doctor itself): the
  deployed-extension check's timeout now spans the whole transfer including
  the body (size-capped, streams cancelled, sockets drained); it fetches the
  myshopify origin with `?_fd=0` so the primary domain's CDN bot protection
  cannot false-FAIL it, and a 403 names bot protection instead of "check
  reachability"; a deployed build with the "Stars only" style WARNs (that
  setting hides the number) instead of PASSing; the review-data table is
  capped at 250 products with stats queried in small chunks; dry-run input
  is length-bounded; and the page copy states plainly that the dry-run runs
  the real chain (Admin API and, with a locale root, storefront lookups).

## 1.31.0 — 2026-08-11

### Fixed — card star badges: translated languages & home-page carousel slides (SPEC-1.31.md)

Two causes of missing star badges on product cards, both reproduced on the live
store (the product-page title badge was never affected):

- **Star badges now show on product cards in every language.** On translated
  storefronts (e.g. `/fr/`), Shopify's Translate & Adapt gives products
  translated URL handles, and the card links carry the translated handle — a
  name the badge lookup only knew in the store's primary language. Every
  collection and home-page card in the other 16 languages silently showed no
  stars. The widget now tells the server which language the page is in, and the
  server resolves the translated handle through the shop's own public product
  data — so translated cards get the same stars as the primary language.
  Requests on the primary language are byte-identical to before.
- **Card stars no longer vanish store-wide at peak traffic (all languages).**
  Deep-audit findings, both silent-killers in the badge fetch layer (the
  product-page badge needs no fetch, which is why it always looked fine):
  (1) the per-visitor rate limit was, in reality, shared — behind
  CDN + Shopify proxy + hosting, the "visitor IP" resolves to a small pool of
  shared proxy addresses, so the 300/hour bucket was effectively a per-store
  cap; at busy hours it drained and every shopper's badge request was
  silently rejected → no stars anywhere. Raised to 2400/hour (badges are a
  cheap, publicly-cached read), documented the shared-bucket mechanics, and
  pinned the floor in the test suite. For true per-visitor limits set
  `CELLEXIA_CLIENT_IP_HEADER=true-client-ip` on Render.
  (2) any HTTP 403 — e.g. a Cloudflare bot-challenge served to a real
  shopper's browser — was misread as the app's own "not live" signal and
  permanently disabled all card badges for that visitor. The widget now
  verifies the 403 body is the app's own JSON before stopping; foreign 403s
  retry on the ladder. Also: the run-once boot guard moved off the DOM (page-
  snapshot optimizers could serialize it and block boot forever), and an
  absent embed config is no longer cached as permanently absent.
- **Card stars now survive a slow-waking backend (all languages).** The
  production backend sleeps when idle on its current hosting tier and takes
  tens of seconds to wake; the widget's single badge fetch failed during
  that window and was never retried on a static page (re-fetches only fired
  on DOM changes) — so quiet-store visitors, including the merchant, saw no
  card stars in ANY language while the product page (server-rendered) looked
  fine. The widget now retries a failed badge fetch on a 5/15/45-second
  ladder — the retries themselves keep the wake-up going — so stars appear
  as soon as the backend is up. NOTE for the deployer: this is a mitigation;
  `docs/HANDOVER.md` prescribes an always-on (paid) instance, and an
  idle-sleeping tier still delays stars by up to ~a minute for the first
  visitor and slows every widget on the reviews page itself.
- **Home-page carousel: every slide keeps its stars.** The product slider
  (infinite mode) clones slides as it re-lays out; a clone created in the split
  second between the widget claiming a card and inserting its badge inherited
  the claim but not the stars — and claimed cards are skipped forever. The
  widget now recognizes exactly those clones and re-queues them, so they get
  their badge on the next pass (from the already-fetched rating, no extra
  request).
- Technical: the extension appends `&root=<locale>` to the badge request only on
  non-default locales (the public cache splits per language by URL; default-
  locale keying is unchanged); the server gains a storefront product-JSON
  resolution step after the DB and Admin lookups, with locale-scoped positive
  caching and a 10-minute negative cache, and never backfills canonical handles
  from it. Adversarial-review hardening on that step: redirects are followed
  manually (≤ 2 hops, https-only, same path, no IP-literal hosts), non-200
  bodies are cancelled to free sockets, and outbound fan-out is double-capped
  (16 fresh lookups per request, 12 in flight process-wide — saturation skips
  without negative-caching). The PDP title badge's `data-cx-badged="pdp"`
  sentinel is exempt from the clone re-queue. New dev-test suite
  `scripts/dev-tests/badges-localized.test.mjs` (32 checks). Extension JS
  asset budget raised 141→145 KiB for this release (package.mjs gate).

## 1.30.0 — 2026-08-10

### Added — QA generator: scheduled auto-publish ("publish time") (SPEC-1.30.md)

The "Status at creation" select is now **Publishing**, with a third option:
*create as pending, publish automatically at a set time (UTC)*. Picking it
shows a UTC date + time (prefilled with the next **06:00 UTC**, the default
publish time); the helper text names UTC as the timezone in use and shows the
equivalent in the merchant's own timezone. The setting is launch-wide: in a
multi-product launch every product's batch publishes at the same instant.

Scheduled batches are generated as ordinary **Pending** reviews (they appear
in Reviews and can be published early by hand). A new in-process publish
scheduler flips each batch to Published once its generation job has fully
finished — the skeptical double-check included — and the instant has passed,
then runs the same aggregate/metafield sync and Q&A-cache invalidation a
manual publish does. The scheduler arms itself for the exact due instant (a
06:00 schedule publishes at 06:00, not "within the hour"), survives restarts
(re-armed by any admin or storefront traffic), and "Retry remaining" on a
scheduled job auto-publishes the retry's new rows too. The jobs table shows
"Pending — auto-publishes …" / "Auto-published …" (always in UTC) on the row.

New migration `20260810090000_add_publish_time` (GenerationJob gains
`publishAt`/`publishedAt`). Admin-only feature: no theme-extension or locale
changes. New dev-test suite `scripts/dev-tests/qa-publish-time.test.mjs`.

## 1.29.1 — 2026-08-09

### Fixed — reviews page: the server-rendered page now has a design

The stylesheet only ever covered the interactive layer (filter bar, JS-rendered
cards, ask/recommend panels, pager) — the entire server-rendered page (header,
stat band, rating distribution, analysis sections, both product tables, the ~36
review cards, methodology) had NO styles at all and rendered as a wall of
browser-default text. The page is now fully designed in the widget's Amazon
style, on the same `--cx-*` tokens (so the "cellexia" skin remap applies
automatically): a 4-card stat band (2-column on mobile), orange distribution
bars, carded analysis sections with accent-bordered quotes, clean data tables
(uppercase muted headers, horizontal-scroll on small screens), review cards
with star rows / verified badge / gray reply boxes / source captions, and a
styled methodology section. Everything uses logical properties and was
visually verified LTR and RTL at mobile and desktop widths.

### Fixed — reviews page: language & i18n fixes across all 17 locales

A full multi-language audit of the brand page (the section, its interactive JS,
the archive, and the server locale paths). Reminder of the documented design
(SPEC-1.19 v1.19.1): the page's chrome and analysis prose are English by design
(the SEO target language); review bodies render in their own language; skin/age/
time/results labels are localized (verified: all 29 keys resolve in all 17
locale files); ask/recommend answer in the shopper's locale. Fixes:

- **Product links no longer eject non-primary-locale shoppers.** All six product
  links (four server-rendered, two in the JS layer — filtered cards and the
  recommender's buttons) were root-relative `/products/x`, sending a shopper on
  `/fr/pages/cellexia-reviews` to the primary-locale product page. They now use
  the locale root (`routes.root_url` / `Shopify.routes.root`).
- **"See translation" now works in original display mode.** SPEC-1.19 §9
  promises per-review translation on the page, but the JS never called the
  existing `/api/translate` endpoint — foreign-language cards in the default
  "original" mode had no translate control at all. Filtered cards now fetch a
  translation on demand (quietly removing the button when translation is
  disabled or unavailable).
- **Verbatim quote language metadata.** Analysis blockquotes hardcoded
  `lang="en"` even when quoting a Japanese/Arabic/Greek review verbatim. Quotes
  now carry their source review's language (stamped at publish time, so old
  analysis rows are covered) and render with `lang` + `dir="auto"`.
- **JS-rendered cards keep their language.** After the first filter change the
  re-rendered cards lost the per-review `lang` attribute the SSR cards have;
  they now set `lang` and `dir="auto"`.
- **Archive RTL.** Archive review articles now carry `dir="auto"`, so Arabic
  bodies are right-aligned with punctuation on the correct side.
- **Multibyte-safe truncation.** All body/reply/excerpt truncations (metafield
  payload, size-gate re-trim, quote excerpts, archive JSON-LD) could split a
  surrogate pair (emoji) and emit a broken character — or ill-formed JSON-LD.
  Now surrogate-safe.
- **Layout bugs visible in every language:** the recommender's product-button
  flex rule also matched the SSR "Reviews by product" section (class collision —
  renamed), and the rating-distribution bar never rendered because its CSS
  didn't exist (added).
- **"1 stars" → "1 star"** in the stars filter and star aria-labels.
- **JSON-LD honesty in debug mode:** synthetic reviews are excluded from
  schema.org Review objects on both the page and the archive (structured data
  has no "Synthetic test review" caption, so they'd read as genuine customer
  reviews to Google). Known remaining caveats while debug mode is on: the
  per-product AggregateRating counts still include synthetic reviews, and
  JS-filtered cards cannot show the "Synthetic test review" caption (the
  SPEC-1.4 §0 DTO whitelist forbids provenance fields in storefront payloads)
  — both acceptable for debugging, both gone once the synthetic exclusion is
  restored.

### Changed — reviews page: synthetic reviews included (DEBUG MODE)

The "Cellexia Reviews" brand page surface now treats synthetic QA reviews like any
other published review, so the page can be debugged on a store whose reviews are
all synthetic. Before this, a store with only synthetic reviews got "No published
customer reviews yet" from the analysis generator and an empty
/pages/cellexia-reviews (the section renders nothing when the published facts
count is 0).

Synthetic reviews now count on every part of the feature:

- the page facts, stats and star distribution (`computeBrandPageFacts`),
- the AI review analysis corpus (`generateBrandAnalysis`),
- the ~36 review cards in the published page payload (`pickBrandPageReviews`),
- the crawlable archive at `/apps/<subpath>/reviews`,
- the brand-reviews list API (`public=1` is accepted but no longer filters),
- the brand ask box / product recommender corpus.

Synthetic reviews are labeled honestly wherever they now surface: a new
`synthetic: "Synthetic test review"` entry in `SOURCE_LABELS` plus matching
branches in the page section's Liquid. Without it, a synthetic review's source
would have been coerced to "storefront" and captioned "Verified review
collected on our store" — a false provenance. (The page's broader marketing
copy — "our customers rate us…", the recommended "Real Customer Reviews" SEO
strings, the methodology paragraph — is deliberately left unchanged; it reads
wrong only while debug mode is on.)

This is a deliberate, temporary deviation from SPEC-1.19 §6 ("synthetic always
excluded"). Every change site is marked with a `DEBUG MODE (v1.29.1)` comment;
to restore the honesty rule, re-add `isSynthetic: false` at the four spots
listed on `PUBLIC_WHERE` in `app/services/brand-page.server.ts` (the synthetic
label entries can stay — they are unreachable once the exclusion is back).
After installing this version, press "Generate analysis" (or "Publish now") on
the Reviews page admin screen to refresh the published page data.

## 1.29.0 — 2026-08-08

### Added — QA generator: hair products + your own product notes (SPEC-1.29)

- **New "Hair product" option.** The generator was built around skincare, so a hair
  serum got reviews about skin. Tick "Hair product" and everything switches: reviews
  talk about hair and scalp (texture, frizz, shine, breakage, volume, scalp comfort),
  the reviewer personas become hair shoppers (18 briefs rewritten for hair), and the
  skin-specific tags ("skin concerns", results like "fewer fine lines") are left off
  the generated reviews so the widget never shows skin filters on a hair product.
  In a multi-product launch every product row has its own checkbox, so one launch can
  mix face creams and hair serums.
- **New "Additional product info" box (optional).** Free text the AI reads alongside
  the product's Shopify description — and treats as the authority when they disagree.
  The field suggests what helps most: what the product does, key ingredients, texture
  and scent, how and when it's used, who it's for, and what realistic results look
  like and after how long. Available per product in multi-product launches too.
  Cost estimates account for the extra prompt text automatically.
- Safe by construction: generation plans stay resume-stable with the new options
  (verified by a new 29-check test suite, `scripts/dev-tests/qa-hair-mode.test.mjs`),
  and existing configs behave exactly as before — both options are off/empty by
  default.

## 1.28.1 — 2026-08-08

### Fixed — cart badges vs. in-cart upsell apps

Two follow-up reports on 1.28.0, both caused by the same assumption: the badge logic
looked for a recognizable quantity selector inside each cart line, but cart apps
(in-cart upsells, order quantity upgrades, subscriptions) redraw cart lines with their
own controls under their own names.

- **The badge now sits above the frequency selector too.** In the cart it anchors
  directly under the item's price — which always comes before the quantity and
  frequency controls — instead of trying to find the quantity selector. So it renders
  title → price → stars → controls, whatever apps add to the line.
- **Turning the option off now sticks.** Previously, when an upsell app redrew a cart
  line (for example after a quantity upgrade), the redrawn line wasn't recognized as
  part of the cart anymore and the stars came back. Cart membership is now decided by
  where the card sits (the cart page, cart form, or any cart drawer — including
  app-owned drawers), not by what controls it contains, and it is re-checked on every
  redraw. Verified with a harness that replays exactly that takeover-redraw.

## 1.28.0 — 2026-08-08

### Added — cart star badges: your own switch, and a better spot (SPEC-1.28)

- **New app embed option "Show star badges in the cart"** (on by default). Turn it off and
  cart items show no star badges at all — on the cart page and in the slide-out cart drawer.
  Star badges on product cards elsewhere (home, collections, search) are not affected; those
  keep following "Show star badges on product cards site-wide" and the position settings.
- **Cart badges now sit above the quantity selector.** Previously the badge landed wherever
  the product-card position rules put it — on the cart page that meant below the quantity
  stepper, under the line price. In the cart the badge now always renders directly above the
  quantity selector, regardless of the card badge position settings, which keep applying
  everywhere else.
- Technical: a cart line item is recognized only when the card sits in a cart context (cart
  form, cart drawer, cart-classed container) AND carries its own quantity control — so
  "You may also like" recommendation cards on the cart page keep behaving like normal
  product cards. With the option off, suppressed items are skipped before any rating fetch.
  The widget JS budget was raised deliberately 139→141 KiB (scripts/package.mjs gate note).

## 1.27.1 — 2026-08-08

### Fixed — home page "Overall reviews" widget now speaks the shopper's language

- **The heading translates.** "What our customers say" was stored once, in the language the
  block was added in, and then shown as-is to every shopper. When the heading is still the
  stock default it now renders in the shopper's storefront language on all 17 supported
  languages (new storefront locale key `overall.heading_default`). A heading you customized
  yourself is left exactly as you wrote it.
- **Product names on the cards translate.** Card footers used to show each product's name in
  the store's primary language. They now use the translated product title for the language
  the shopper is browsing in — the same translation Shopify's Translate & Adapt manages —
  everywhere the widget renders: the instant server-side render, the live re-render, star
  filtering, and theme-editor previews. For products the server render didn't cover (e.g.
  after a star filter), the widget looks the translated name up from the shop's own public
  product data; if that lookup can't answer, the stored name is kept.
- **Product links stay in the shopper's language.** Links used to point at `/products/…`,
  which lands on the primary-language page. They now carry the storefront language prefix
  (`/fr/products/…`), so a shopper reading French reviews lands on the French product page.
  On the primary language nothing changes.
- **Review dates localize too.** The server-rendered cards printed dates in English
  ("March 15, 2026") in every language; they are now re-rendered in the shopper's locale
  ("15 mars 2026") in both translation display modes.
- Technical: the block resolves titles/URLs through Liquid `all_products` (translated per
  request locale, URL locale-prefixed) and hands the JS a handle→title/URL map
  (`data-cx-pmap`) plus the locale root (`data-root-url`); the widget JS asset budget was
  raised deliberately 137→139 KiB for this (scripts/package.mjs gate note).

## 1.27.0 — 2026-08-08

### Improved — home page "Overall reviews" widget

- **Featured reviews no longer read alike** (SPEC-1.27). The widget's auto-ranking used to
  judge reviews only by helpfulness, verified purchase, photos, length and recency — it never
  looked at the words. On stores with imported or generated reviews, several featured cards
  could open with the same headline ("Love this cream" / "Love this cream!") or bodies that
  read like the same review re-worded. The ranking now skips a candidate whose headline or
  text reads too much like a review already on display and features the next best distinct
  one instead — in every language the app supports.
  - **No review disappears.** Look-alikes are only demoted, never hidden: they still appear
    further down the widget's list, on later pages of the reviews page, and in every count.
    And if a store simply doesn't have enough distinct-reading reviews, the widget fills its
    slots exactly as before rather than showing fewer cards.
  - **Hand-picked reviews are untouchable.** Reviews you selected yourself are always shown
    exactly as picked — the similarity rule only stops the automatic backfill from echoing
    them.
  - Applies everywhere the widget gets its data: the instant server-side render, the live
    re-render when a shopper clicks a star bar, theme-editor previews, and the brand reviews
    page's first screen.
  - New real-code regression suite `scripts/dev-tests/brand-diversity.test.mjs` (41 checks)
    covers headline clones, re-worded bodies, hand-picked seeding, the never-shrink
    guarantee, the 2-per-product cap, star filters, pagination integrity and the
    non-Latin-script edge cases (Arabic optional pointing folds; Japanese voiced/unvoiced
    kana stay distinct words) — restoring the brand-page suite the dev-tests README notes
    was lost.

## 1.26.2 — 2026-08-08

### Fixed — health check

- **"Preview token round-trip" no longer fails on stores with plenty of reviews.** The
  health check truncated every probe response to 2,000 characters *before* parsing it as
  JSON. A healthy reviews payload — the probe deliberately targets the most-reviewed
  product, and a valid preview token adds the merchant-only meta block — is routinely
  larger than that, so the truncated body failed to parse and the check reported a
  Critical failure while quoting the perfectly valid HTTP 200 response it had just
  received. The response is now parsed in full; the 2,000-character cap only applies to
  the snippet kept for the merchant-facing failure detail. Previews and the storefront
  were never affected — the check was wrong, not the connection.

## 1.26.1 — 2026-08-07

### Fixed — translations on the storefront

- **Topic call-out quotes now match the language of the page.** Clicking a mention chip
  ("14 customers mention Price and value") quoted the reviews' original text — French quotes
  on an English page — even while the reviews below showed their translations. Quotes now
  excerpt exactly the text the shopper sees, and if a shopper switches one review to
  "See original", an open panel follows suit.
- **The home page Overall widget no longer leaves the odd review untranslated.** When the
  first translation pass missed a review (a provider hiccup), that review stayed in its
  original language on the homepage indefinitely. The widget now makes one follow-up request
  for exactly the missed reviews — the result is cached, so it also stays fixed for every
  later visitor. The catch-up never fights a shopper who has already started reading or
  scrolling, and it works in preview links too.

## 1.26.0 — 2026-08-07

### Added — QA review generator

- **Generate for several products in one launch** (SPEC-1.26). Set everything up once —
  languages, human touch, the skeptical double-check, and the rest — then add more products
  under **"More products in this launch"**. Each extra row is a copy of your current settings
  and lets you change only what differs per product: review count, target star average,
  verified-purchase %, merchant-replies %, variant assignment, and the date range. Up to 20
  products per launch; each becomes its own background job, so the activity bar shows
  combined progress and every product can still be cancelled or retried on its own.
  - **Estimate covers the whole launch**: one total ("3 products · 260 reviews · ≈ $…"), a
    line per product, and it clears itself the moment you change anything so you can never
    approve one number and run another.
  - **Nothing half-starts.** Every product is checked — including that it still exists in
    Shopify — before any job is queued. If something goes wrong while queueing, the message
    names exactly which jobs did start so they are never accidentally launched twice; a
    double-click can't duplicate a launch either.

## 1.25.2 — 2026-08-07

### Fixed — QA review generator

- **Reviews no longer say "1 to 3 months in".** The generator was handing the writing model
  the literal range label from the usage-time setting, and the model repeated it — no real
  shopper describes their own usage as a range. Each review now gets one concrete duration
  inside the chosen band ("2 months", "6 weeks", "almost 3 months"…), varied across the
  batch, and the model is told to phrase it naturally in the review's language and never as
  a range. The stored attribute (used for filtering) keeps the band exactly as before.

## 1.25.1 — 2026-08-07

### Fixed

- **The developer test suites now actually run on any machine.** The five suites shipped in
  1.25.0 hardcoded an absolute path to the machine they were written on, and used a path
  idiom that breaks on Windows. They now resolve the app's folder from their own location
  and use the portable path API — verified by running every suite from a clean checkout.
  Packaging now fails outright if either mistake ever reaches a release again. Apologies to
  whoever hit this first.

## 1.25.0 — 2026-08-06

### Added — QA review generator

- **"Human touch level" slider (0–100).** 1.24.0's fixed writing mix read too messy on a real
  store, so how human the reviews sound is now yours to set. 0 = every review polished.
  50 (the default) ≈ half the reviews carry a small slip — the pre-1.24 feel. 100 = most
  reviews read hurried, though a share always keeps a slip or two rather than everything
  turning to mush. Applies to headlines and bodies alike; mistakes never change facts or
  ratings; the skeptical double-check continues to treat deliberate slips as human, not as
  something to remove.

### Internal

- The developer regression suites (money accounting, curation parity, the QA generator's
  checks) now live in the repo at `scripts/dev-tests/` instead of a session workspace, so
  they ship with every ZIP and cannot be lost. `node scripts/dev-tests/<name>.test.mjs` runs
  any of them with no database or API key.

## 1.24.0 — 2026-08-06

### Added — QA review generator

- **A skeptical double-check on every generation** (SPEC-1.24). After a batch is generated, a
  second AI agent — briefed to hunt for signs of machine writing — re-reads the stored reviews
  in groups and removes the ones it convicts: uniform rhythm, over-balanced pros-and-cons,
  assistant vocabulary, the same arc repeating across reviews, generic praise with no lived
  detail. Deliberate human mess (typos, lowercase, fragments) is explicitly protected — it
  convicts on structure and substance, never on spelling. Two new options next to the other
  generator settings: **Skeptical double-check** (on by default) and **Reviews per check**
  (5–60, default 20 — more per call is cheaper and better at spotting repetition; fewer means
  closer scrutiny). The job shows "Double-checking…" during the pass and reports how many
  were removed, so a batch can finish slightly under the requested count. The checker can
  never touch real customer reviews, a checker failure keeps the batch and says so, and the
  cost estimate includes the extra calls. Groups are kept per-language so the "same phrase
  across reviews" lens actually works.
- **Even more human writing, headlines included.** The style mix moves to roughly 30% clean,
  40% with a slip or two, 30% clearly hurried — and titles now follow the same dial: lowercase
  starts, dropped punctuation, dashed-off fragments. Sloppy reviews stay native-feeling and
  never change facts or the rating's meaning.

### Fixed

- A long double-check can no longer be mistaken for a stalled job (it now signals liveness
  throughout, and its progress is saved group by group, so a crash loses at most one group).
  A resumed job can never regenerate the reviews the double-check removed. Cached
  translations of removed reviews are cleaned up and product ratings re-sync after removals.

## 1.23.0 — 2026-08-06

### Changed — QA review generator

- **No fragrance-absence claims, ever.** Generated reviews must never state the product is
  perfume-free, fragrance-free, unscented or similar — that is a factual claim about the
  product. The generator is instructed not to, and as a hard backstop any generated review
  containing such a claim is dropped before it is stored — checked against the natural
  phrasings of all 17 store languages (verified per language, including inflected forms,
  spellings without accents, and Greek uppercase). Describing how a product smells is still
  allowed. Real customer reviews are never touched by this — it applies only to generated
  QA data.
- **No emojis, ever.** The generator is instructed not to use them, and everything it
  produces is scrubbed of emojis, pictographs, flags, keycaps and similar symbols as a
  backstop — across titles, bodies and brand replies.
- **More human writing.** Instead of the old "5% of reviews get one typo", each generated
  review now draws a writing style: about half are clean, a third have one or two small
  slips (a typo, a missing apostrophe, a lowercase sentence start), and the rest read
  clearly hurried — several small grammar mistakes and imperfect capitalization, still
  natural in their language. Mistakes never alter facts, ratings or product names.

## 1.22.0 — 2026-08-06

### Added

- **Choose where the star badge sits inside product cards** on collections, the home page and
  search results. New app-embed setting **"Star badge position on product lists"**: same as
  the product page (the default — nothing changes on upgrade), under the product title, under
  the tagline, or **under the price**. A card missing the chosen element falls back (price →
  tagline → title); a badge is never dropped because of this setting. The price detection
  ignores sale pills ("-20%"), unit prices, compare-at labels and the hidden duplicate price
  many themes render for mobile/desktop — so the badge lands after the price a shopper
  actually sees. Labels in all 17 admin languages (SPEC-1.22.md).

### Internal

- The widget JS size gate was raised deliberately (132 KiB → 137 KiB) for this feature — the
  gate exists to catch accidental growth, and this note is its audit trail.

## 1.21.0 — 2026-08-06

### Changed

- **Under the AI-curated order, the default sort is now labeled "Most relevant" instead of
  "Top reviews"** — in all 17 languages. "Top reviews" invites shoppers to audit the order
  against helpful-vote counts, and a curated order deliberately does not follow them; a
  skeptical shopper spotting a low-vote review above a high-vote one reads that as the store
  hiding something. "Most relevant" sets the honest expectation. The label changes ONLY when
  a curated order is genuinely being served for that product and language — products without
  a curation fall back to the classic order and keep saying "Top reviews", so the label never
  overpromises. "Most recent" is unchanged and shoppers can still sort and filter everything.

### Fixed

- The locale check now also verifies widget strings all the way into the snippet that
  actually delivers them to the storefront. A gap there could previously let a string exist
  in every translation file yet render as a raw key on the product page (caught while
  building this release).

## 1.20.5 — 2026-08-06

### Fixed

- **"The AI's answer could not be read" on many runs — root cause found and closed.** Two
  problems stacked:
  - **Background runs never noticed when an answer ran out of room.** "Curate all" runs as a
    background batch, and a product with many reviews could overflow the answer allowance the
    same way in every language — which is why the same product failed in French, Italian and
    English at once. The immediate run already detected this; the background run fed the cut-off
    answer to the reader and reported it as unreadable, with advice ("re-run it") that could
    never help. Background runs now detect it identically, and the answer allowance is doubled
    so a full-length answer fits with room to spare.
  - **The reader was too strict about how the answer is wrapped.** A perfectly good answer
    was thrown away if the model added a remark containing a brace, repeated the answer twice,
    wrote line breaks inside the explanation, or quoted a review using bare quotation marks.
    The reader now handles all of these, and when the order list survived but the explanation
    broke, the order is applied with the explanation left blank instead of failing the run.
    A cut-off answer still always fails — a half-finished order is never applied.

- **When an answer still cannot be read, you now see it.** The failure list shows the
  beginning of what the model actually said, so a stubborn case is diagnosable at a glance
  instead of being a guess. The failure messages were also reworded to give advice that is
  true for each cause.

## 1.20.4 — 2026-08-05

### Fixed

- **The cost preview's Overview-field note counted deleted products as "empty Overview".** A
  store with deleted products could be told its Overview field was empty on products that do
  not exist — contradicting the deleted-products note in the same window. The note now counts
  only products Shopify actually returned.
- **A very large catalogue could have part of its run silently dropped.** When the preview
  runs out of time on a huge catalogue it scopes the run to what it measured; an internal
  cap could then trim that list again without saying so. The cap is now far above anything
  the preview can measure.
- **A failed packaging check no longer destroys the previous release ZIP** (internal tooling:
  the new ZIP is built to a temporary name and only replaces the old one after every check
  has passed).

## 1.20.3 — 2026-08-05

### Fixed

- **The 1.20.2 truncation fix now covers every AI feature, not just curation.** The same
  "thinks until the answer no longer fits" behaviour could bite the AI summary, the summary's
  translations, the brand-page analysis, the shopper Q&A box on product pages, and the QA
  review generator — anywhere the app asks the model for a structured answer within a fixed
  output allowance. All of them now tell the model to answer directly, exactly as curation
  does. Use this ZIP rather than the 1.20.2 one from earlier today.

- **A run near your spending limit can no longer squeeze past it.** The pre-run check now
  assumes the most a single call could bill rather than the typical figure, so the limit holds
  even in the worst case. The preview still quotes the typical figure, which is what runs
  actually cost.

## 1.20.2 — 2026-08-05

### Fixed

- **Around 90% of curation runs were failing with "the AI call failed — try again in a
  minute".** Root cause: on the Claude model this app uses, the AI now *thinks before
  answering* by default, and that thinking is billed as output and counted against the same
  small output allowance the app gives each curation call. Small products left enough room;
  the big review sets 1.20.0 started sending made the AI think at length, use up the whole
  allowance, and get cut off before the answer began — so the bigger the product, the more
  certain the failure, which is exactly the ~90% pattern. Curation calls now tell the model to
  answer directly (as it effectively did when this feature was built), and the output
  allowance is larger so a full answer fits even in the most token-expensive languages.
  Background (batch) runs send the identical instruction. Costs are unchanged — if anything
  slightly lower, since billed thinking is gone.

- **The Haiku model would have been handed requests it cannot accept.** Claude Haiku reads at
  most a fifth of what the app's payload ceiling assumed. If you switched the AI model to
  Haiku, any large product's run was rejected outright. The payload limit now follows the
  selected model, trimming to fit before sending.

- **"The AI call failed — try again in a minute" said the same thing for six different
  problems**, and the advice was wrong for most of them. Failures now say what actually
  happened: the AI service being busy (retry *is* right there — and the app now also waits as
  long as the service asks before retrying, instead of a fixed 1.5 seconds), a refused API
  key (check Settings), a rejected request, an answer that ran out of room, an answer that
  could not be read, or an answer that did not name enough real reviews.

## 1.20.1 — 2026-08-05

### Fixed

- **The cost preview said "There is nothing to curate right now" even for products with
  plenty of published reviews.** 1.20.0 quietly narrowed what the AI Curator is allowed to
  read: it started skipping reviews created by the QA review generator. Those reviews are
  *shown to shoppers* when they are published — the product page has never filtered them out
  — so on a store populated that way the curator suddenly had nothing to order, and the
  preview came back empty. The curator now reads exactly the set the product page serves:
  every published review, whatever created it. On a mixed store this also matters in a
  quieter way — 1.20.0 would have ordered only part of what the page displays.

  (The public **Cellexia Reviews** brand page is the one place that deliberately leaves
  QA-generated reviews out, and it is unchanged. That page makes public claims about real
  customers, so it should exclude them; the product-page ordering should not.)

- **An empty preview now explains itself instead of guessing.** The modal used to assert two
  specific reasons — "needs at least 3 published reviews" and "must still exist in Shopify" —
  without the app having checked either, which is what made the problem above hard to place.
  It now reports what it actually found: no reviews yet, reviews still waiting for approval,
  products under the three-review minimum, or products Shopify would not return (and, for
  that last one, that a temporary Shopify error looks the same as a deleted product, so it is
  worth trying again).

- **"Run in the background" could submit nothing after the preview promised a run.** The
  batch action kept its own copy of the "which products are curatable" query, and 1.20.0 left
  that copy narrower than the other two — so on the same store the preview would price, say,
  three calls and the background run would submit zero. All three paths (preview, Run now, Run
  in the background) now share one definition, and packaging the app fails outright if the
  curator's review query ever drifts from the storefront's again.

- **A Shopify hiccup no longer reports itself as a deleted product.** Every failure reading a
  product from Shopify — an expired session, a missing permission, a rate limit, an outage —
  was being turned into "product not found in Shopify, it may have been deleted". They now
  read differently: a deleted product says so, and a Shopify error says it is usually
  temporary and worth retrying. A session that needs re-authorising is also no longer
  swallowed, so Shopify can prompt you to reconnect instead of the feature quietly not
  working — it says to reopen the app from Shopify admin, which is the thing that fixes it.
  A rate limit or an outage says "try again in a minute" instead, and only skips that one
  product rather than abandoning the whole run. Shopify also reports some failures as a
  *successful* response carrying an error inside it; those were reading as "product deleted"
  too, and no longer do. The same distinction reaches the hourly background refresh, so a
  Shopify problem there is never filed as a failed AI call that sends you to check your API
  key.

- **"No Claude API key is configured" was shown to stores that have one**, when the AI
  provider was simply switched off in Settings. The two now read differently.

- **The preview mentions an empty Overview field.** If the Overview field you configured has
  no content on some products, the preview says so — curation still works from the product
  description, but the agents are reading less than they could.

### Worth knowing when you upgrade

- **Products you have already curated will show "Reviews changed — re-curate", and that is
  correct.** Those orders were decided from a smaller set of reviews than the agent can see
  now — either because 1.20.0 was hiding your QA-generated reviews from it, or because before
  1.20.0 it only ever read the 60 most recent. The badge is telling you the truth: a fresh run
  will read more and can order better. Nothing re-runs on its own unless you have Automatic
  refresh set to Daily or Weekly, and if you do, it still stops at your monthly spending limit.

## 1.20.0 — 2026-08-05

### Changed

- **The AI curator now reads every review — the two old limits are gone.** Until now each
  agent saw at most the 60 most recent reviews of a product, and the app refused more than
  300 curation runs a day. Both are removed. Every agent is handed the product's complete
  published review set, and the only ceiling left is the model's own context window: if a
  product's reviews genuinely will not fit in one call, the app first shortens the longest
  review texts (2000, then 1200, then 800 characters each — still plenty to judge a review
  by), and only if that is still not enough does it drop reviews, keeping a deliberate spread
  across 5, 4, 3, 2 and 1 stars instead of just the newest. Whenever that happens the status
  table says so ("read 640 of 812"), so a partial reading is never presented as a full one.

### Added

- **A cost preview that costs nothing.** The new **Estimate cost** button builds exactly the
  payload every agent would receive, measures it with Anthropic's free token-counting
  endpoint, and shows the real input-token count, the number of product-and-language runs and
  the price in dollars at your model's published rates — before a single billable call is
  made. It translates nothing and generates nothing. On a large catalogue it measures a
  sample exactly and extrapolates the rest, and states plainly which numbers are which. If
  reviews still need translating (in "All reviews, translated into each language" mode) it
  counts them and prices that separately, because that is billed too. An unknown model shows
  "cost unknown" rather than an invented number.
- **Background runs at half price.** From the preview you can choose **Run now** (immediate,
  standard rates) or **Run in the background**, which submits the work to Anthropic's batch
  service at a **50% discount**. Results come back within 24 hours — usually much sooner — and
  the app polls and applies them by itself within a few minutes, so you can close the tab —
  or press **Apply results now** if you would rather not wait. The card lists every background
  run with its status, how many runs succeeded or failed, and what it cost, and a running
  batch can be cancelled.
- **A monthly spending limit.** Set a dollar amount and the app tracks what curation has
  actually cost this calendar month against it — real billed tokens, not estimates — and
  refuses a run that would take you over instead of quietly spending. Leave it empty for no
  limit. The running total is always on screen. Automatic (Daily/Weekly) refreshes obey the
  same limit, which is what now bounds them in place of the deleted daily cap.
  - Translations count too. In "All reviews, translated into each language" mode a run pays
    for the translations it needs, on the same Claude key, so those are billed to the same
    limit. (DeepL and Google are your own separate accounts and are excluded, with the
    preview saying so rather than quoting you a made-up figure.)
  - A background run **reserves** its estimated cost the moment it is submitted, because a
    batch is not billed until it comes back. Without that, three background runs started in
    a row would each be checked against a total that had not moved yet. The reservation is
    corrected to the real cost when the results land, and given back if you cancel.
  - Only one background run at a time, so a double-click or a browser retry cannot bill the
    same work twice.
  - If you set a model this app has no published price for, the card says plainly that costs
    cannot be measured and the limit cannot be enforced for it, instead of leaving you with a
    limit that quietly does nothing.

## 1.19.2 — 2026-08-03

### Fixed

- **Deployment audit fixes.** A full pre-deployment review of the app, the theme extension,
  the database migrations and the handover docs found and fixed:
  - **Webhook API version mismatch**: `shopify.app.toml` declared webhooks at API version
    2025-01 while the app itself calls 2025-07, so webhook payloads could arrive shaped for a
    different version than the code expects. Both are now 2025-07.
  - **The "Create the page" button needed a permission that was never requested.** Creating
    `/pages/cellexia-reviews` from the admin uses Shopify's `pageCreate`, which requires the
    `write_content` scope. It is now requested (and documented as optional — without it the
    app still shows the manual steps). Adding a permission means approving the app once more
    after deploying.
  - **An app-embed setting had no label in any language.** The "Show the review Q&A box"
    toggle (added in 1.16.0) referenced translation keys that existed in none of the 17
    files, so the theme editor showed a raw key instead of a label. Labels and help text
    added in all 17 languages.
  - **Silent data loss on redeploy is now impossible to miss.** The deploy walkthroughs hand
    you a `DATABASE_URL`, but Prisma ignores it until the database section of
    `prisma/schema.prisma` is switched to read it (INSTALL.md §4) — the app would run fine and
    lose every review on the next redeploy. Startup now refuses to boot with a precise
    explanation when `DATABASE_URL` is set but ignored.
  - **The dev database could be baked into the Docker image**: `.dockerignore` used `*.sqlite`,
    which does not match `prisma/dev.sqlite` (Docker patterns do not cross `/`). Fixed, along
    with the same latent issue for `*.log` and `.DS_Store`.
  - **Documentation corrections**: the permission list was stale in five places, the install
    steps told you to `cd` into a folder the ZIP never creates, the extension was described as
    having two app blocks (it has four), the troubleshooting table quoted a migration count
    less than half the real number, and the 1.19.0 reviews page was missing from both the
    install steps and the final verification checklist.

### Added

- **Two more release gates.** Packaging/verification now fails if a block setting references a
  translation key that exists in no locale file (the exact defect above, which cross-language
  parity checks cannot catch), and startup blocks the ignored-`DATABASE_URL` case described
  above.

## 1.19.1 — 2026-08-02

### Fixed

- **The extension now deploys: locale data was over Shopify's platform limits.** Shopify
  caps each theme-app-extension locale file at 15 KB and ALL locale data at 256 KB
  combined; after 1.19.0 the Greek, Arabic and Japanese files were individually over the
  per-file cap and the total had reached 325 KB, so `shopify app deploy` refused the
  extension. Locale files are now stored compactly (identical content, no wasted
  whitespace) and the reviews page's own labels are written directly into the section
  instead of being duplicated across 17 translation files. Largest file is now 12.5 KB
  and the total 202 KB, leaving real headroom on both limits. Nothing else changed for
  shoppers, and every other translation in the app is untouched.
- **Note on the reviews page's language.** Its headings and labels are now English, which
  matches the page's purpose (ranking for the English search "cellexia reviews") and the
  AI analysis, which was already written in English by design. Reviews themselves still
  appear in the language they were written in, and the rest of the app remains fully
  translated in all 17 languages.

### Added

- **Release gates for Shopify's platform limits.** Packaging now fails loudly if any
  locale file exceeds 15 KB, if total locale data exceeds 256 KB, or if the extension's
  Liquid exceeds 100 KB, so a future update can never again produce a ZIP that cannot be
  deployed.

## 1.19.0 — 2026-08-02

### Added

- **The "Cellexia Reviews" page** (SPEC-1.19) — a dedicated, crawlable brand-reviews
  knowledge page built to rank for "cellexia reviews" and to feed AI assistants
  (ChatGPT, Claude, Perplexity) real facts about the brand's reviews:
  - A new app SECTION ("Cellexia Reviews page") for an Online Store 2.0 page at
    `/pages/cellexia-reviews` (the app can create the page for you from the new
    **Reviews page** admin screen). Everything on it is server-rendered from a shop
    metafield — H1 and exact-phrase opening paragraph with live numbers, the full
    rating distribution with counts and percents, total sample size and date range,
    ~36 evidence-rich review cards (product, rating, date, Verified Purchase, skin
    concerns, age, usage duration, results seen, source, store reply), a
    best-product-by-skin-concern table, a per-product ratings table, and a
    review-collection & moderation methodology section. Critical reviews are
    guaranteed visible. Synthetic QA reviews are always excluded from this page.
  - A **citation-ready AI analysis** with five visible sections ("Are Cellexia
    reviews positive?", results reported, common complaints, best products by skin
    concern, how long results take). Every number is computed by the app, never by
    the AI; the AI writes the prose and picks quotes, and every quote is verified
    verbatim against the source review (with a link to it). Generated on demand from
    the admin, refreshed with one click.
  - A fully **crawlable archive** of ALL reviews at `/apps/<subpath>/reviews`,
    server-rendered inside the theme with plain-link pagination and filters by
    product, skin concern and star rating — no JavaScript needed to read any review.
  - **Correct structured data**: Organization (no self-serving rating), WebPage,
    BreadcrumbList, and per-product Product + AggregateRating + Review JSON-LD built
    from the same data the page visibly renders.
  - **Interactive extras** (each can be turned off): filter bar, an "Ask our reviews
    a question" box, and a "Which product is right for me?" recommender that answers
    from reviews and links the recommended products. Progressive enhancement only —
    the page is complete without JavaScript.
  - The admin **Reviews page** screen: setup checklist (create page, add section,
    generate analysis, publish data), robots.txt guidance for AI crawlers
    (OAI-SearchBot, ClaudeBot, GPTBot, PerplexityBot), navigation/sitemap notes,
    and the feature toggles. Page data auto-refreshes when reviews change.

## 1.18.0 — 2026-08-02

### Added

- **AI Curator: "What the agents read" option** (SPEC-1.18). New select on the AI
  curation card. Default ("What each language's shoppers see") keeps the 1.17.0
  behavior: each language's agent reads originals in its language plus existing
  translations, with untranslated foreign reviews marked as foreign. The new mode
  ("All reviews, translated into each language") makes every agent read the complete
  review set translated into its own language: reviews never translated before are
  translated at curation time with your configured translation provider and cached
  forever (each translation is billed at most once, ever) — and in this mode every one
  of the 17 languages gets its own curation for any product with at least 3 reviews.
  Reviews that can't be translated (provider off or a provider error) are still
  included, marked with their original language, so a run never fails because of
  translation.
- **AI Curator: automatic refresh** (SPEC-1.18). New "Automatic refresh" select on the
  card: Manual only (default — exactly today's behavior), Daily, or Weekly. When on, the
  app checks hourly in the background and re-runs ONLY curations whose reviews have
  actually changed since they last ran, at most once per day/week per product and
  language. The first curation of a product is always started by you; automatic runs go
  through the same 300-per-day cap, concurrency limit and failure reporting as manual
  ones, and their results appear in the same status table.

## 1.17.0 — 2026-08-02

### Added

- **"AI curated" review order — conversion-optimized, per language** (SPEC-1.17). An
  optional new order system on the Display page: a skeptical AI agent reads the product's
  description AND your Accentuate "Overview" field (configurable `namespace.key`), works
  out what prospects are likely doubtful about, judges every review's credibility
  (specific, balanced, plausible beats generic praise and too-perfect superlatives), and
  puts the good reviews that best answer those doubts first. It runs SEPARATELY for every
  language: each language's agent has its full instructions written natively in that
  language and evaluates the texts shoppers of that language actually see (originals and
  existing translations) — so French shoppers get a French-curated order, Japanese
  shoppers a Japanese-curated one. Helpful-vote counts are never an input. Everything is
  visible in the admin: per product × language you see when curation ran, over how many
  reviews, a freshness badge, and the agent's full reasoning in that language. You can add
  your own guidance to all agents ("our buyers worry most about…"). Curation runs only
  when you press Curate (never from storefront traffic), one AI call per product per
  language, capped at 300/day, with hand-picked featured reviews still winning over the
  curated order and every uncurated case falling back to the Amazon-style order.
  Safety rails: "Curate all" shows a confirmation with the expected scale first; a
  missing Claude API key means an explicit "nothing queued" (never silent); runs that
  fail are listed in the card and can be retried immediately; the freshness badge also
  notices reviews published after a curation ran; products with fewer than 3 reviews are
  skipped entirely; and the agents are instructed, in every language, to never follow
  instructions embedded inside customer review texts.

## 1.16.1 — 2026-08-01

### Fixed

- **The stars-position setting now applies to product cards too.** The app embed's
  "under the title / under the tagline" choice only moved the badge on product pages;
  the star badges injected under product names on the home page and collection pages
  ignored it and always sat directly under the name. With "Under the tagline" selected,
  card badges now sit under the card's short description (`.product__blurb` /
  `.product__subtitle`, or the next paragraph after the title) — and cards without a
  tagline safely keep the badge under the title. Verified against the live theme's real
  card markup in both modes. The setting's label now says it covers product pages and
  product cards, in all 17 admin languages.

## 1.16.0 — 2026-08-01

### Added

- **The AI summary now switches itself on** (SPEC-1.16 §1). Stores whose reviews were
  imported before an API key was saved never got a "Customers say" summary — nothing
  generated it. The summary endpoint now schedules a background generation the first time a
  product with published reviews is viewed and no summary exists (once per product,
  debounced, silent) — so after deploying, summaries appear on their own within a couple of
  page views per product. "Regenerate all now" in Settings still works for bulk refreshes.
- **Review Q&A — "Looking for specific info?"** (SPEC-1.16 §3, opt-in via Settings → AI).
  A search box under the AI summary where shoppers type a question and get an answer
  generated from the product's reviews, with up to three supporting customer quotes
  (verbatim — the server verifies every quote against the actual review text and drops
  anything the model invented). Answers speak as the brand in first person ("our cream"),
  in the shopper's language, in all 17 locales. Suggested question pills are generated per
  product with the summary. Cost controls: every distinct question per product+language is
  answered once and cached forever, shopper requests are rate-limited (20/h per visitor),
  and fresh answers are capped at 200 per day per store. A per-block theme-editor toggle
  can hide the box per surface.
- **Amazon-matched summary styling** (SPEC-1.16 §2, measured from amazon.com 2026-08-01):
  20px "Customers say" heading, 14px summary/disclaimer with a neutral AI mark, 14px topic
  links with the green ↗ (#067D62) for positive topics and ~ for mixed, counts in ink —
  on desktop and mobile, in all three design versions.

### Changed

- Widget JS byte cap 128 → 132 KiB and CSS 60 → 64 KiB for the Q&A box (gate stays active).

## 1.15.0 — 2026-08-01

### Fixed

- **Literal "&#39;" and other HTML entities in storefront text.** French (and any
  language) could show raw entities — "Tranche d&#39;âge", "Voir l&#39;original" — when
  Shopify's Translate & Adapt overrides delivered HTML-escaped strings; the widget renders
  text safely via textContent, so the escapes displayed literally. The dictionary reader now
  decodes numeric and named HTML entities on ingestion (safe by construction: everything
  still renders as text, never as HTML), curing tainted strings from any upstream source in
  all 17 languages. `npm run check:locales` additionally fails the build if an entity ever
  appears in the app's own locale files.

### Added

- **Homepage Overall reviews block follows the translated display mode.** With
  Settings → Translation → display set to automatic translation, the homepage block's
  reviews now appear in the shopper's language by default — with the same
  "Translated from …" note and "See original" toggle as the product widget — instead of
  their original language. Translations come from the same cached per-language store
  (each review+language pair is paid for once, shared with the product widget). Note for
  existing installs: open Settings and press Save once after updating so the new
  display-mode flag reaches the theme.

### Changed

- The entity decoder is single-pass (decoded output is never rescanned, so
  double-encoded text stays faithful) and covers the typographic named entities
  translation tools emit (’ ‘ ” “ … – — é è ç ü ö ß etc.). The homepage block only
  repaints its server-rendered cards when at least one review actually has a translation,
  and the translated mode obeys the same "translations possible at all" collapse as the
  product widget — turning Translate off stops homepage auto-translation too. Widget JS
  byte cap raised 124 → 128 KiB for the decoder table (packaging gate stays active).

## 1.14.0 — 2026-07-31

### Added

- **Go live in selected markets only** (SPEC-1.14). A new Dashboard card, "Markets — where
  your reviews go live", limits storefront visibility to chosen Shopify Markets. The
  per-market decision is made by Shopify's Liquid renderer on every page view
  (`localization.market.handle` against the app-synced `cellexia.live_markets` metafield) —
  never by client-side geo guessing — and fails closed: any ambiguity (missing market
  context, malformed data) renders the not-live state. Markets not selected keep their
  storefront byte-for-byte unchanged. Market picking needs no new API scopes: handles
  register themselves when the storefront is visited (or can be typed manually), and the
  optional `read_markets` scope adds a friendly named list (see UPDATE.md).
- **Stamped takeover in live markets.** An opt-in toggle hides the incumbent Stamped
  reviews — the product-page widget (with its "More Product Reviews" heading) and the
  Stamped stars under product names on product, home and collection pages — exactly and
  only in markets where Cellexia Reviews is live. The hide is a CSS style tag emitted
  inside the Liquid live-market branch (structurally incapable of appearing in other
  markets), one rule per selector so older browsers degrade gracefully, CSS-only and
  instantly reversible. Selector defaults were measured from the live Cellexia theme; an
  advanced admin field can override them, sanitized so style-tag injection is impossible.
  The tokenized preview simulates the takeover for the merchant's tab only, before
  anything goes live.
- JSON-LD star rich snippets now follow the same market gate, so search engines only see
  Cellexia ratings for markets where they are actually shown.

### Changed

- Widget JS byte cap raised deliberately 120 → 124 KiB for the preview simulation and
  market reporting (SPEC-1.14 §8); the packaging gate remains active.

## 1.13.0 — 2026-07-31

### Added

- **Full Claude API key management in Settings → AI summary.** Changing the key was already
  possible (paste + Save) but invisible and unverifiable; now the field shows the last four
  characters of the saved key (the full key never leaves the server), the help text spells
  out the replace flow, a **Test key** button verifies the key in the field — or the saved
  one — against the Anthropic API for free and reports precisely what is wrong (invalid or
  revoked key, missing permissions, or a model unavailable on that account), and a
  **Remove saved key** button clears it, pausing AI summaries, the QA generator and Claude
  translations gracefully until a new key is saved.

## 1.12.1 — 2026-07-30

### Fixed

- **Star orange now matches Amazon's current color exactly — measured, not eyeballed.**
  The stars everywhere (product-page review widget, the rating badge under the product
  title, collection/home card badges, the homepage Overall reviews block, the review form's
  star picker and the ratings-breakdown popover bars) previously used #FFA41C with a darker
  #DE7921 border — the palette of Amazon's *legacy* large star sprite. Amazon's current UI
  (verified by downloading and pixel-sampling the star sprite and stylesheet that
  amazon.com serves today) draws every shopper-visible rating star as flat **#FF6200** with
  no darker border, empty stars as white with the same #FF6200 outline, and the histogram
  meter bars as #FF6200 on white with a #888C8C outline. All of those values are now
  applied in the amazon design version — one token change covers every surface — and the
  admin's own star previews match. The Cellexia (ink/periwinkle) and Luxe (champagne)
  design versions are untouched. A reviews *block* saved with the old default accent color
  auto-upgrades to the new orange; a deliberately customized accent still wins.

## 1.12.0 — 2026-07-30

### Added

- **Amazon-exact product-page rating badge with ratings-breakdown popover** (SPEC-1.12).
  The badge under the product title now matches Amazon's anatomy exactly: the average
  ("4.6") before stars rounded to the nearest half star like Amazon does, a small caret,
  and the review count ("(1,936)", locale-formatted) as a link in Amazon's link blue that
  scrolls to the reviews. Clicking or hovering the stars opens the ratings-breakdown
  popover — stars + "4.6 out of 5", "1,936 global ratings", the 5→1 star meter rows
  (white bars, orange fill, blue labels and percents, Amazon's exact colors), a divider and
  "See customer reviews" — with a close X, Escape and tap-outside dismissal, and viewport
  clamping so it renders perfectly on mobile. Clicking a star row jumps to the review list
  filtered to that rating. The star distribution is served instantly from the product
  metafield (with a fallback to the first widget load), all 17 languages are covered
  (two new strings), and the cellexia/luxe design versions restyle the same structure
  through their existing tokens. Card badges on home/collections keep their layout but
  adopt the half-star display rounding and the blue count for visual parity.

### Changed

- **Asset byte-budget caps raised deliberately** (SPEC-1.12 §7): widget JS 112 KiB → 120 KiB,
  CSS 55 KiB → 60 KiB, to make room for the popover. The packaging gate remains active
  against accidental growth.
- `npm run check:locales` now also verifies that every locale key the widget JS consumes is
  actually emitted by the storefront dictionary snippet (`cx-i18n.liquid`) — a missing
  snippet entry previously showed shoppers a raw key name and was invisible in demo
  verification, which uses its own hand-written dictionary.

## 1.11.0 — 2026-07-30

### Changed

- **Review translations read like a shopper wrote them.** The Claude translation prompt now
  instructs the translator to keep each reviewer's casual register (quirks, slang, small
  imperfections), never to polish or embellish, to avoid AI-flavored wording (stiff connectors,
  brochure superlatives), and never to use em or en dashes — restructuring with commas, periods
  or parentheses instead, even when the original review used a dash.
- **Deterministic dash scrub on every served translation.** Regardless of provider (Anthropic,
  DeepL, Google) and regardless of when the translation was cached, em/en dashes are stripped
  from translated titles, bodies and brand replies before they reach the storefront or the
  cache — so translations cached before 1.11.0 come out clean too, with no migration needed.
  The scrub is locale-aware: Japanese gets the ideographic comma (、), Arabic the Arabic comma
  (،), everything else ", ". It is also meaning-preserving: a dash between numbers is a range
  ("results in 2–3 weeks") and becomes a plain hyphen ("2-3 weeks"), never a comma; commas and
  spacing on parts of the text the dash never touched are left exactly as written; and adjacent
  commas of any script collapse so the result never doubles up. Reviews displayed in their
  original language are never altered — a human reviewer's own dash stays. A review whose body
  is nothing but dashes is served untranslated instead of being re-sent to the paid translation
  provider on every page load. The QA generator's scrub now uses the same locale-aware
  replacement for its non-English reviews.

## 1.10.3 — 2026-07-27

### Fixed

- **Collection preview really resolves `shop-all` now.** The 1.10.1 resolver filtered
  collections on the deprecated `publishedOnCurrentPublication` field, which actually means
  "published to the calling app's own sales channel" — this app is not a sales channel, so
  every collection (including `shop-all`) looked unpublished, the list came back empty and the
  preview link fell through to the `/collections/all` fallback on every store. The resolver now
  uses Shopify's documented search filter (`published_status:published`, retrying unfiltered if
  that errors or matches nothing), scans up to 250 collections instead of 50, and caches a
  fallback result for only 60 seconds (a real resolution still caches for ten minutes), so a
  transient API hiccup can't pin the wrong link. Verified against the real service code with a
  six-scenario mocked Admin API test, including a replay of the Cellexia store's exact case.

## 1.10.2 — 2026-07-28

### Fixed

- **Overall reviews block spacing on full-bleed themes.** On themes whose sections have no
  inner container (like the Cellexia theme), the homepage Overall reviews block ran nearly
  edge-to-edge on desktop and mobile. It now reuses the widget's gutter detection: when its
  section is full-bleed it centers itself at the theme's measured content width with generous
  side padding (24px on mobile up to 64px on desktop, matching the surrounding sections);
  themes that already provide a container are untouched. Re-checked automatically on window
  resize and rotation.

## 1.10.1 — 2026-07-28

### Fixed

- **Collection preview opens the store's real catalog collection.** The Collection page entry
  in the preview menu previously hardcoded Shopify's implicit `/collections/all`. It now
  resolves the store's own catalog collection (preferring the handles `shop-all`, `all`,
  `all-products`, `shop`, then the first published collection, with `/collections/all` as the
  final fallback), so previewing lands on the page shoppers actually visit — on the Cellexia
  store, `/collections/shop-all`. The result is cached for ten minutes.

## 1.10.0 — 2026-07-28

The "preview works everywhere" release. Previewing was honest but half-blind: it could show
you a product page, and nothing else reliably. This release makes the private preview work on
the home page and collections exactly as it does on product pages, explains below — honestly —
why it didn't before, adds a position choice for the product-page stars, and gives the QA
generator per-language and per-variant distribution controls.

### Fixed

- **Previewing the home page or a collection page showed no badges and no Overall reviews
  block — even with everything configured correctly.** Two real causes, both in the app, both
  now fixed:
  1. **Preview had exactly one entry point: a product page.** The Dashboard's
     **Preview on your store** button only ever built a product-page link — and the small
     piece of code that captures the private token from that link and stores it in the
     browser tab lived inside the product-page review widget's start-up code, so it only ran
     on pages where that widget exists. Navigating *from* a previewed product page to the
     home page in the same tab did carry the preview along — but opening the home page or a
     collection **directly** (a new tab, a typed address, the theme editor's "view" link)
     gave that page no token, and the not-live rules then did exactly what they are designed
     to do for shoppers: hide everything, silently. Which is precisely how merchants
     naturally test those pages. Now a shared preview bootstrap runs on **every** page that
     contains any Cellexia surface (widget, card badges, or the Overall block): it captures
     the token wherever it arrives, shares it with all three surfaces, shows the preview
     ribbon on every previewed page while the store is not live, and **Exit preview** works
     from any page. And the Dashboard button is now a small menu with three destinations —
     **Product page**, **Home page**, **Collection page** — so every page type has a direct,
     tokenized way in (the collection link uses the built-in "all" collection every Shopify
     store has).
  2. **The Overall reviews block rendered literally nothing until its homepage data had been
     synced.** The block paints from a shop-level data snapshot that, in 1.9.0, was only
     written after a review changed status or after pressing **Refresh homepage data** — so
     on a freshly deployed store the block showed nothing at all, even in the theme editor
     and in preview, with no hint of why. Now, in merchant contexts (theme editor or a valid
     preview), the block fetches your live review data on the spot and renders the full
     section **before any sync has happened**; if the store genuinely has zero published
     reviews, it shows a note only you can see — "Overall reviews will appear here once
     review data is synced. Open the app's Display order page and press Refresh homepage
     data." — instead of blank space. The app also refreshes the snapshot by itself, best
     effort, each time it (re)authenticates after a deploy, so real stores converge without
     anyone pressing Refresh. Shoppers on a live store see exactly what they saw before.
- **An expired preview no longer goes silently blank on badge pages.** When a home or
  collection page carries a preview token that has expired (or was invalidated with
  **Regenerate preview link**), the page now shows the existing "Preview session expired"
  notice — visible only to you, once per page — instead of quietly showing nothing and
  leaving you to guess which of the two it was.

### Added

- **Product-page stars position** (app embed): the star row under the product page's own
  title can now sit under the tagline instead. Two new embed settings, next to **Show stars
  under the product title**:
  - **Product-page stars position** — "Directly under the title" (the default: byte-identical
    to the previous behavior) or "Under the tagline". The tagline is found automatically
    (the theme's tagline/subtitle element, or the first paragraph after the title); when a
    theme has none, the stars fall back to under the title rather than not appearing.
  - **Stars placement (CSS selector, optional)** — advanced: the stars are inserted after
    the first element matching the selector, overriding the position choice — same pattern
    as the card-badge selector override.
- **QA generator: language distribution.** When more than one language is selected, the
  configuration card shows one percentage share field per selected language, prefilled with
  an even split, with a live "Total: N%" readout that must come to 100% (an off-by-one
  percent from rounding is tolerated and normalized to the exact review count). Review
  counts per language are derived deterministically from the shares and interleaved across
  the batch. When only one language is selected the editor does not render and the previous
  behavior (even split with natural jitter) applies; a visible editor's percentages are always
  sent and normalized exactly, so an untouched editor yields a precise even split.
- **QA generator: variant distribution.** The same share editor for product variants when
  **Assign product variants** is on: one row per variant title plus a "No variant" row, the
  same 100% rule, the same deterministic assignment. With the variants toggle off the editor
  does not render and the previous default weighting applies; a visible editor's shares are
  always applied exactly as displayed.

### Changed

- **Generated reviews no longer contain em or en dashes.** AI-written test reviews had a
  telltale: dashes (— and –) that real shoppers rarely type. The generator's persona briefs
  and style rules were rewritten dash-free, the model is explicitly instructed to avoid
  them, and a deterministic scrub cleans any that slip through in titles, bodies and replies
  (ordinary hyphens, as in "anti-aging", are untouched).

### Notes

- **Live-store shopper behavior is byte-identical to 1.9.0**, with one intended exception:
  the new stars-position option, when a merchant selects it. Preview tokens and merchant
  notices remain invisible to shoppers, as always.
- No database migration, no new dependencies, no new app permissions. One new storefront
  string (the merchant-only Overall-block note) translated in all 17 languages; the two new
  embed settings translated in all 17 theme-editor (schema) locales.
- Documentation updated: `docs/CONFIGURATION.md` §2 ("Going live & previewing") rewritten
  around the three preview destinations and how preview follows you across pages; the app
  embed section documents the stars-position settings; the QA data section documents the
  distribution editors; the Overall reviews section documents the pre-sync preview behavior.

## 1.9.0 — 2026-07-27

The "your whole brand's reviews, on your home page" release: one new, optional theme block
that shows the store-wide rating and your strongest reviews across **all** products — Amazon's
trust language adapted to a homepage — plus the admin controls to curate it. Everything is
additive: stores that never add the block see zero change.

### Added

- **"Cellexia Overall Reviews" theme block** — a brand-wide review section for the home page
  (or any page whose template supports sections): theme editor → your page → **Add section**
  (or Add block) → Apps → **Cellexia Overall Reviews**. It renders, entirely server-side for
  an instant first paint with zero API calls on load:
  - a centered, homepage-scale header: your combined rating across every product's published
    reviews as a large star row with "4.8 out of 5", "Based on 12,438 reviews across our
    products", and — whenever at least 60% of those reviews are verified purchases — the
    trust line "93% from verified purchases";
  - optional **clickable rating-distribution bars**: a shopper who clicks the 5-star bar sees
    only 5-star reviews (one request, re-rendered in place), with an **All stars** chip to
    return to the featured set;
  - your top reviews across all products as condensed review cards — stars, bold title, a
    clamped excerpt with **Read more**, author, date, **Verified Purchase** badge, a media
    indicator for reviews with photos or video — each card linking to its product's review
    section ("Read 6,214 reviews") when **Link each review to its product** is on;
  - an optional call-to-action button (**Button label (optional)** + **Button link**, e.g.
    "Shop bestsellers").
  - Block settings: **Heading** (default "What our customers say"), **Number of reviews to
    show** (3–12, default 6), **Layout** — **Grid** (1 column on phones, 2 from 640 px,
    3 from 1024 px) or **Carousel** (swipeable snap row with previous/next arrows; the row
    stays natively scrollable even without JavaScript) — **Show rating distribution bars**,
    **Link each review to its product**, and the button pair above. All labels translated in
    all 17 schema locales; the three new storefront strings are translated in all 17
    storefront languages.
- **You choose what leads** — the **Display order** page gains a third card, **"Overall
  reviews (homepage widget)"**:
  - **Auto** (default): "Our ranking picks your strongest recent reviews across all products,
    max 2 per product" — reviews rated 4 stars or better, scored by helpful votes, Verified
    Purchase status, attached photos/videos, a substantial (but not rambling) text, and
    recency, with a **diversity rule**: never more than 2 reviews from the same product, so
    the block reads like a brand, not one bestseller. Only if too few reviews qualify does
    the bar relax to 3 stars — never below.
  - **Hand-picked**: choose up to 12 reviews yourself, searching every product's published
    reviews (with rating filter and product column), in your exact order, with keyboard-
    friendly ↑ / ↓ / Remove buttons. If you pick fewer than the block shows, the auto ranking
    backfills the rest; a picked review that loses its published status drops out by itself.
  - A **Refresh homepage data** button pushes the current numbers to your theme immediately —
    the card's help text says the rest: "updates automatically as reviews change; changes
    appear within a minute" — and a stats preview (average, count, verified share) shows
    exactly what the block will display.
  - The fast path: every review's own page gains **Feature on homepage** / **Unfeature**
    beside the 1.8 product-level action (same cap of 12).
- **Brand-wide storefront endpoint** — `GET /apps/<subpath>/api/brand-reviews` (own rate
  bucket, 120/h) powers the distribution-bar filtering: shop-wide stats plus reviews across
  products, each with its product's title and link. Same HMAC verification, same
  live/preview gating, same 60-second caching, and the same strict field whitelist as the
  product review API — nothing merchant-only leaks.
- **Shop metafields** `cellexia.shop_rating` and `cellexia.shop_top_reviews` carry the
  aggregate and the chosen top reviews to the theme for the server-side paint. They re-sync
  automatically whenever reviews change (batched, so bulk imports stay cheap) and immediately
  on the admin card's Save / **Refresh homepage data**.
- **Demo page**: an "Overall reviews" showcase beneath the widget — the block in both Grid
  and Carousel layout, fed by a mock brand payload (4.8 average, 12,438 reviews, 93%
  verified, 6 top reviews across 4 products), fully offline, exercising Read more, the
  carousel arrows and the distribution filter, and following the three-skin Design switcher.

### Notes

- **Deliberately no structured data from this block.** Google disregards self-serving
  organization-level star ratings, so the home-page block emits no JSON-LD at all — your
  product pages keep carrying the rich-snippet markup that actually earns stars in search.
  The reasoning is documented in `docs/SEO.md`.
- **Shopper-safety rules unchanged**: while the store is not live, the block renders nothing
  for visitors (hidden shell, zero requests); the theme editor and tokenized previews show it
  fully. A shop with zero published reviews renders no empty frame — nothing at all. If a
  distribution-bar request ever fails, shoppers simply keep the server-rendered cards; no
  error boxes.
- One database migration (a `Setting.overallWidget` column) is applied automatically on
  deploy. No new dependencies, no new app permissions. Existing blocks, the app embed and the
  product-page widget are byte-identical to 1.8.0 — this feature is purely additive.
- All three design versions (Amazon like, Cellexia, Luxe) style the new block in their own
  language: uppercase Gobold heading for Cellexia, serif heading with champagne accents for
  Luxe.
- Documentation updated: `docs/CONFIGURATION.md` gains an "Overall reviews widget" section,
  `docs/SEO.md` explains the no-structured-data decision, and the demo README covers the new
  showcase.

## 1.8.0 — 2026-07-26

The "you decide what shoppers read first" release: a full review display-order system, an
automatic-translation display mode — and the real fix for the card-badge bug, with its actual
cause explained below rather than papered over.

### Added

- **Review display order** — a new **Display order** page in the app navigation (between
  Reviews and Bulk add) controls which reviews shoppers see first, at two levels:
  - **A store-wide default ranking**, chosen from six systems, each described on the page in
    plain language with a small star-row example: the Amazon-style helpfulness ranking (the
    default — exactly how the widget has always ordered "Top reviews"), top positive first,
    most recent first, Verified Purchases first, photos & videos first, or a balanced mix that
    alternates three positive reviews with one critical so shoppers can see nothing is being
    hidden. Two optional boosts — **Show Verified Purchase reviews first** and **Show reviews
    with photos first** — push those reviews ahead in any system except the balanced mix
    (whose fixed rhythm is the point).
  - **Per-product control**: a table of every product with published reviews shows the system
    in effect ("Default (Amazon-style)" until overridden) and how many featured reviews it
    has. **Edit display** opens a per-product editor: keep **Use the store default** or pick a
    system for that product only, and hand-pick **Featured reviews (shown first)** — up to
    **10 per product**, in your exact order, with keyboard-friendly up/down/Remove buttons and
    a searchable, rating-filterable picker of the product's published reviews. There is also a
    fast path straight from moderation: a **Feature on product page** / **Unfeature** action
    on each review's own page.
  - Featured reviews lead page 1 under the default "Top reviews" sort; the moment a shopper
    re-sorts, searches or filters, the shopper's choice wins — as the editor's banner puts it:
    "Featured reviews always appear first under the default sort. Shoppers can still re-sort
    and filter." The three server-rendered top reviews (page source + Google structured data)
    follow the same selection, so what search engines index matches the live widget.
    Storefront review data is cached for 60 seconds, so display changes appear to shoppers
    within a minute; the server-rendered data re-syncs immediately on save.
  - **Nothing changes out of the box**: the default remains the Amazon-style ranking with no
    featured reviews — until you change something, shoppers see exactly the pages they saw
    on 1.7.0.
- **Translation display mode** — Settings → Translation gains a "Reviews written in other
  languages" choice: **"Show in the original language, with a Translate button (default)"**
  (the existing behavior, unchanged) or **"Automatically translate into the shopper's
  language, with a 'See original' option"**. In the automatic mode, a review written in
  another language appears already translated, marked "Translated from …", with a
  **See original** link — and **See translation** to switch back (one new storefront string,
  translated in all 17 languages). The per-review Translate button and the "Translate all
  reviews" link are hidden in this mode, since they would be redundant. Honest expectations:
  the mode needs a translation provider **and** its API key; the first page-load in a language
  whose translations don't exist yet can take a few seconds while they are created, after
  which they are cached and instant for every later visitor; and if the provider fails or the
  key is missing, the widget simply falls back to the original language with the Translate
  button — never an error.

### Fixed

- **Star badges on product cards (home, collections, search) never appeared — and product
  pages were silently paying for the same bug.** The cause was found by measuring the live
  store's rendered pages, and it was real, not a configuration issue: the app writes its
  internal storefront address (the app-proxy path its scripts call) through a small theme
  snippet, and **Shopify wraps every rendered app snippet in invisible HTML comments**
  (`<!-- BEGIN app snippet: … -->` … `<!-- END app snippet -->`) — including inside captured
  variables and attribute values. Those comments ended up embedded in the address everywhere
  it was consumed, turning it into an invalid URL. Two consequences: the **card-badge script
  failed on every page, live or preview** — its one batched request never reached the app, so
  no badges, ever — and the main product-page widget only *looked* healthy because the
  address-recovery sweep added in 1.5.1 rescued it after one failed request, meaning **every
  product page silently wasted a request and added latency on every single load**. 1.8.0
  fixes all three layers: the theme files now strip the comment wrappers at every point the
  address is used; the script strips comments and validates the address before trusting it,
  falling back to its discovery sweep otherwise; and the badge script now shares the widget's
  recovered address, so badges self-heal from any future path corruption exactly like the
  widget does. The internal verification harness now reproduces Shopify's comment-wrapping in
  its replica theme, so this class of bug can never pass unnoticed again.

### Notes

- One database migration (a `ProductDisplayConfig` table plus three `Setting` columns) is
  applied automatically on deploy. No new dependencies, no new app permissions, one new
  storefront string ("See translation") translated in all 17 languages.
- Out of the box the storefront is byte-identical to 1.7.0: Amazon-style default order, no
  featured reviews, original-language translation mode. The merchant-only preview data rules
  (1.6) and the background-generation behavior (1.7) are untouched.
- Documentation updated: `docs/CONFIGURATION.md` gains a "Review display order" section and a
  rewritten Translation section; the card-badge troubleshooting entries in
  `docs/CONFIGURATION.md` and `docs/FAQ.md` now state the real root cause above.

## 1.7.0 — 2026-07-25

The "generate as many as you want — and know what it costs first" release. The QA review
generator (the **QA data** page) used to top out at 200 reviews per batch, run only while you
kept the browser tab open, handle one batch at a time, and give no hint of what a run would
cost or how long it would take. All four limits are gone.

### Added

- **Generation now runs in the background, on the server.** Clicking **Generate** starts a
  job and returns immediately — a toast confirms: "Generation started — you can leave this
  page". Navigate anywhere in the admin or close the tab entirely; the reviews keep being
  created either way. The form stays filled, so a second, different run can be launched right
  away: several jobs run simultaneously (the app works on up to two at a time per store and
  queues the rest). If the app's server restarts mid-run, the job picks up where it left off —
  reviews already created are kept, and the job never overshoots the number you asked for.
- **No more 200-review cap.** Generate any number of reviews for a product in one request.
  The page keeps you informed rather than fencing you in: above 500 reviews an inline warning
  names the estimated cost and duration, and above 5,000 the confirmation asks you to
  re-confirm the figures ("Generate 8,000 reviews? Estimated $X and ~Y.") before anything
  starts. Reviews are written in small chunks as they are generated, so even a
  10,000-review run stays light on the server.
- **Cost estimate before you spend.** A new **Estimate cost** button next to **Generate**
  (optional — generating never requires it) shows what a run should cost:
  "≈ 12,400 input + 20,800 output tokens · **≈ $0.35** · about 4 minutes", with a second line
  naming the basis — "Based on your last 27 generated batches" once the app has measured your
  store's own throughput, or "Based on a token count of one sample batch" before that — and
  the pricing applied, including the Claude Sonnet 5 introductory-pricing note while that
  rate lasts. The estimate refreshes by itself when you change the review count. Estimates
  are approximate by nature; the **actual** cost of every job, computed from real token
  usage, is shown in the jobs table once the job finishes. As always, all usage is billed by
  Anthropic to your own API key — the app itself never charges anything (`docs/FAQ.md` has
  the per-model rates).
- **Time estimates that learn your store's speed.** Duration predictions are calibrated from
  your own store's measured generation throughput, not a generic guess — and while a job
  runs, its remaining-time readout is recomputed from that job's actual pace, so it
  self-corrects within the first minute.
- **A Generation jobs table** on the QA data page: the 50 newest jobs with status, product,
  progress bar (created / target), live remaining time for running jobs, elapsed time and
  actual cost for finished ones, and per-row actions — **Cancel** (stops after the in-flight
  chunk; reviews already created are kept), **Retry remaining** (re-queues just the missing
  reviews of a failed or cancelled job into the same batch), **View reviews** and
  **Delete batch** (which also removes the job, cancelling it first if needed). Chunk-level
  hiccups are retried once, then skipped and reported honestly — a job only fails outright
  when nothing could be created at all or the Anthropic key is missing or invalid.
- **Progress visible from every admin page.** While any job is active, a compact dismissible
  banner under the navigation reads "Generating reviews — 148 of 500 · about 7 minutes left"
  and links back to **QA data** — so a long run is never out of sight, whatever page you are
  on.

### Notes

- **Storefront behavior is byte-identical** to 1.6.0 — this release changes only the admin
  side of the generator. Synthetic reviews keep every safety property from 1.4: internally
  flagged, batch-tracked, filterable, one-click deletable, warned about on the Dashboard, and
  never labeled on the storefront — delete every batch before going live.
- One database migration (two new tables, `GenerationJob` and `ModelThroughput` — the jobs
  and the per-store speed calibration) is applied automatically on deploy. No new
  dependencies, no new app permissions, no locale changes.
- Background jobs run inside the app process and assume the single-instance deployment the
  app already requires — see the note in `docs/INSTALL.md` §4 if you host on more than one
  instance.
- Documentation updated: `docs/CONFIGURATION.md` §10 rewritten around background generation
  and estimates, `docs/FAQ.md` gains "How much does generating reviews cost?" with the
  per-model rates, `docs/INSTALL.md` §4 single-instance note.

## 1.6.0 — 2026-07-24

The "why is nothing showing?" release. On a real store, three separate problems could combine
into one confusing picture: the theme editor showed **"Reviews could not be loaded. Please try
again."**, the product page showed no stars under the title, and product cards had no star
badges — with no way to tell from the admin what was actually wrong. All three are fixed below,
and the app can now prove its storefront connection works **before** you go live.

### Fixed

- **"Why do I see nothing when my reviews are published?"** Two blind spots closed. If reviews
  exist for a product but none are approved yet, the widget now tells you so while you preview —
  "No published reviews yet — 12 awaiting approval in the app" — instead of looking empty, and
  the Dashboard reports total / published / pending counts with the fix (approve them, or turn
  on auto-publish). And if the app ever fails to push your ratings into Shopify (an expired
  permission, a rate limit, an API error), that failure used to disappear into a server log
  nobody reads: the exact error is now recorded, shown in the **Storefront connection** card with
  what to do about it, and re-runnable with **Re-sync all products**, which reports the real
  result per product instead of a generic success toast.
- **"Reviews could not be loaded. Please try again." in the theme editor.** The theme editor
  deliberately renders the widget even when your store is not live, so you can place it — but
  the widget shown there had no way to identify itself to the app. Every request for review data
  was therefore refused, and the widget fell back to that generic error message. Nothing was
  broken on your storefront; the editor simply could not ask for the data. The app now hands the
  theme editor the same private key that **Preview on your store** uses, so the editor shows your
  real reviews, styled exactly as shoppers will see them. An expired preview key — or one you
  invalidated with **Settings → Data → Regenerate preview link** — used to produce the very same
  error; it now says **"Preview session expired"** and tells you to reopen the preview from the
  Dashboard.
- **Shoppers never see an error box.** If anything at all goes wrong on a live storefront — the
  app unreachable, a network hiccup, a mis-addressed request — the widget now removes itself
  quietly instead of printing a failure message on your product page. Explanatory messages exist
  only for you: they appear in the theme editor and in preview mode, they say on themselves that
  only you can see them, and they are never part of a normal shopper's page — nor is the private
  preview key, which is only ever added to the page inside the theme editor. The one thing a
  shopper can still see is deliberately gentle: if the connection drops *after* reviews have
  already loaded, the reviews they were reading stay on screen and a small "Try again" link
  appears under the list. Nothing is ever taken away mid-read.
- **The storefront address is detected automatically.** The widget reaches the app through a
  Shopify "app proxy" address (`/apps/cellexia-reviews/...` on your own domain). That address
  used to be written down in two places that had to agree by hand; when they disagreed, every
  request quietly 404'd and the widget just never appeared. The app now discovers the address
  itself, stores it for the theme to read, and the widget re-discovers it in the browser if a
  request ever comes back wrong — retrying once, invisibly. Installations on a different proxy
  path work with no extra steps.
- **A misconfigured setup can no longer hide.** Every one of the failures above used to be
  invisible from the admin. They are now all covered by the connection test below.

### Added

- **Storefront connection test** — a new **Storefront connection** card at the top of the
  Dashboard, with a **Run test again** button. It checks the full path between your storefront
  and the app and shows a plain-language fix next to anything that isn't right:
  1. **App proxy reachable** — the storefront can actually reach the app (and which address it
     is using).
  2. **Preview token round-trip** — your private preview link really works end to end.
  3. **Theme extension active** — whether the widget has been loaded on your storefront
     recently; warns if it never has (usually: the **Cellexia Reviews** app embed is still off in
     Theme settings → App embeds).
  4. **Review data** — how many published reviews exist. Warns at zero, because a store with no
     reviews correctly shows no stars anywhere.
  5. **Metafield sync** — the ratings the theme reads match the ratings in the app, with a
     **Re-sync all products** button if they've drifted. This is what draws the stars under the
     product title, the card badges and the Google star data.
  6. **Database persistence** — catches the hosting setup where reviews would be wiped on the
     next deploy.
  7. **Live state** — live or not live, with the link to go live.
  When everything passes the banner reads **"Storefront connection verified"**. The test runs by
  itself when you open the Dashboard if it has never run or the last run is more than a day old,
  and the **Go live** confirmation now shows the current summary — asking you to confirm a second
  time if a check is failing.
- **Straight answers while previewing**: instead of a generic error, preview mode and the theme
  editor now show what to do — "Preview session expired", "Storefront connection not configured"
  (with the address that was tried), or a **Try again** button after a network problem. An empty
  widget adds "No reviews yet — import your reviews or generate test data in the app." Shoppers
  see none of these.
- **For your developer**: `npm run selftest -- --shop=<store>.myshopify.com` runs the same proxy
  probe from a terminal and prints PASS/FAIL per candidate address, so a deployment can be
  verified before handover (`docs/INSTALL.md` §10). A new, always-available
  `/apps/<subpath>/api/ping` endpoint answers with the app's name and version — it exposes no
  review data and no personal data.

### Notes

- **No stars yet after installing?** That is almost certainly not a fault: this app shows only
  the reviews it holds itself. Reviews still living in a previous review app are not visible
  here until you bring them over — **Import / Export** for a CSV, or **QA data** for realistic
  test reviews while you evaluate the layout. The connection test spells this out under
  **Review data**.
- One database migration (two new fields) is applied automatically on deploy. No new app
  permissions, no new dependencies, and the storefront design is unchanged apart from the small
  notice style that only you can see.
- Documentation updated: `docs/INSTALL.md` (§10 verification, §11 troubleshooting),
  `docs/CONFIGURATION.md` (§1, "Storefront connection test"), `docs/FAQ.md`, `docs/HANDOVER.md`.

## 1.5.1 — 2026-07-24

Polish release for the app embed, driven by preview testing on the live Cellexia theme
(cellexialabs.com). No settings, translations, schema or backend changes — all three design
versions and block-mounted pages behave as before.

### Fixed

- **Embed placement & spacing on real themes**: on themes that render the add-to-cart form
  with JavaScript (as the live Cellexia theme does), the embedded widget used to fall back to
  the very end of the page and could sit flush against the screen edges with no margins. The
  widget now watches for the late-rendered add-to-cart area for up to 4 seconds and moves
  itself right below that section — but never while you are already reading it or have a
  dialog open. Wherever it ends up, it now manages its own spacing: on full-bleed pages it
  centers itself, aligns with the theme's own content width and adds proper side gutters;
  inside a theme container it adds breathing room above and below only.
- **Stars under the product title**: the star row under the product page's own title is now
  found on far more themes (including heading wrappers like the live theme's `.pdp__heading`),
  and it appears even when the store has no synced rating data yet — the widget's first data
  load fills it in, with no extra request. Also: tuned spacing under the heading, and the
  review count now picks up the theme's own font.
- **Star badges on product cards**: card detection was rebuilt around how real themes mark up
  product cards — including cards where the product link wraps only the image and the title
  sits in a separate element next to it (exactly the live theme's markup). Badges now appear
  on home, collection and search cards on such themes, on their own line right below the card
  title, and every card is badged at most once. Header, navigation, footer and breadcrumb
  links are never badged.
- **Little things**: review dialogs, the photo lightbox and the filter sheet now always sit
  above sticky theme headers; the preview ribbon sits just below the dialogs so it can't cover
  them; star badges no longer stretch the line height of card titles; very long unbroken words
  in review text can no longer overflow their box; the review form sheet respects the iPhone
  bottom safe area; and small layout guards keep the controls row tidy on 320 px screens.
- **Audit follow-up (same release)**, from a line-by-line review against the live theme:
  - The storefront now calls the store's **actual app-proxy path**
    (`/apps/cellexia-reviews/api`, matching `[app_proxy]` in `shopify.app.toml`). The path is
    written in exactly one place (`snippets/cx-proxy.liquid`) and flows into both blocks and
    the embed config, so it can never drift between files again.
  - Card badges on the **home page and collections** now work: those pages have no review
    widget to read the API address from, so the embed's config script now carries it.
  - On cards whose title block also contains a marketing blurb, the stars now sit **directly
    under the product name**, not below the blurb.
  - Product sections that load **as you scroll** (e.g. recommendation grids) reliably get
    their badges: page activity from carousels or mini-carts no longer uses up the badge
    scanner's budget.
  - The widget's spacing and width now **re-adjust when a phone is rotated** or the window is
    resized.
  - The review form's **Cancel/Submit bar** respects the iPhone home-indicator area while the
    sheet is being scrolled, not just at the very end.
  - Two internal guards fixed: the widget no longer risks a visible page jump on iOS Safari
    if it moves below the add-to-cart area while you have started scrolling, and the
    stars-under-the-title row can no longer be inserted twice.

## 1.5.0 — 2026-07-23

### Added

- **App embed — the widget on every theme, one click** (`blocks/embed.liquid`): some themes
  don't accept app blocks on product templates, which made the widget impossible to place
  there. The new app embed (theme editor → Theme settings → **App embeds** → toggle
  **Cellexia Reviews** → Save) mounts the full review widget on every product page
  automatically, right after the product-information / add-to-cart area — with an optional
  **Widget placement (CSS selector, optional)** override for exact positioning — and can show
  a compact star row with the review count under the product page's own title
  (**Show stars under the product title**; skipped automatically when the Cellexia Star Badge
  block is already on the page, hidden while the product has no published reviews). The blocks
  remain fully supported and preferred where the theme accepts them: on any page where the
  Cellexia Reviews block is present, the block wins and the embed steps aside — nothing ever
  renders twice, including the JSON-LD structured data, which is deduplicated. Install docs
  now offer the two paths side by side (`docs/INSTALL.md` §8, Option A app embed / Option B
  blocks).
- **Site-wide star badges on product cards**: with the app embed enabled
  (**Show star badges on product cards site-wide**), star ratings appear next to product names
  anywhere on the store — home page, collections, search results, featured-product sections —
  for every product with at least one published review; products without reviews are left
  untouched. **Badge style** picks "Stars and review count" (★★★★★ (123)) or "Stars only";
  badge size inherits from the surrounding card text, and all three design versions apply.
  Card titles are detected automatically across common theme markup, with an advanced
  **Card title element (CSS selector, optional)** override for unusual themes. Cost per page:
  at most one batched request covering up to 48 products (cached 5 minutes), zero requests on
  pages without product links — and nothing at all while the store is not live. Merchant
  detail: `docs/CONFIGURATION.md`, "App embed & star badges".
- **Badges endpoint**: `GET /apps/cellexia/api/badges?handles=…`
  (`app/routes/proxy.api.badges.tsx` + `app/services/badges.server.ts`) — proxy-verified,
  rate-limited (new `badges` bucket, 300/h), and live/preview-gated exactly like every other
  storefront route; returns `{ "badges": { "<handle>": { "average", "count" } } }` for
  published-review products only, using the same rounding-safe math as the widget's own
  stats.
- **Product handle on submissions**: the widget now sends the product handle
  (`product_handle`) alongside the product id when a review is submitted, and the backend
  persists it — this is what lets badges resolve products without extra Admin API lookups
  over time.
- Embed settings translated in all 17 **schema** locales (theme-editor UI); the storefront
  locale files are unchanged — badges reuse existing strings for their accessibility labels.
- Demo page: a "product card grid" showcase under the widget — six theme-style product cards,
  four of which pick up injected star badges from the new mock payload
  (`CellexiaDemoData.badges`), while a zero-review card (and one more without reviews) stays
  clean. Works offline like everything else in the demo, and follows the design-version
  switcher.

### Compatibility

- **Block-only stores see byte-identical behavior vs 1.4.1** — every change is additive, and
  the app embed ships **disabled**: until a merchant switches it on in the theme editor,
  nothing on the storefront changes at all. When enabled on a not-live store, visitors still
  get zero visible change and zero API data (the badges endpoint answers 403 like the rest);
  preview mode and the theme editor show full function, per the 1.2 gating rules.
- No new dependencies, no storefront locale-file changes, no database migration.

## 1.4.1 — 2026-07-23

First-install hardening release (no functional changes):

- `docs/INSTALL.md`: pre-flight decision list and a full troubleshooting appendix (§11) mapping
  every anticipated fresh-install failure to its fix.
- `docs/HANDOVER.md`: brought up to date with all v1.1–v1.4 features.
- Release ZIPs no longer include the internal build-specification files (`SPEC*.md`).

## 1.4.0 — 2026-07-23

### Added

- **CSV import overhaul** (Import / Export page; see `docs/CONFIGURATION.md`, "Importing
  reviews"): a documented **generic template** (22 columns, downloadable from the page with
  two realistic example rows), Judge.me / Loox / Yotpo presets **auto-detected** from the
  file's headers, a **Date format** select for ambiguous `DD/MM` vs `MM/DD` dates,
  **full-file validation** before anything is written (per-row errors with row, field and
  message — first 50 in a table, the rest as a downloadable error report), **duplicate
  skipping** (same product + same author email or name + identical text), a default-status
  select (Published / Pending), review media as external image/video URLs, and **chunked
  import with a progress bar** for large files, with ratings and metafields re-synced once
  per affected product at the end. The CSV export gains three tracking columns
  (`is_synthetic`, `source`, `synthetic_batch_id`) and otherwise keeps the template's exact
  column names for round-trip fidelity.
- **Bulk add** (new page, between Reviews and Import / Export): enter many reviews for one
  product directly in the admin, no file needed. Product picker, then a review composer —
  rating, title, body, author, email, date, verified, language, variant, the four structured
  skincare answers, an optional reply, and media (up to 5 images + 1 video per review, mixed
  from web addresses and direct file uploads to Shopify Files). Reviews stage into an
  editable list and save in chunks with progress; failed rows stay in the list with their
  errors, and leaving the page with unsaved rows warns first.
- **Synthetic QA review generator** (new "QA data" page): AI-generated realistic test
  reviews for QA of the widget and design versions, using the Anthropic API key from
  Settings → AI Summary. Fully parameterized — product, count (1–200 per batch), target
  average rating (with a derived integer-star distribution and preview), verified %,
  languages (with per-locale reviewer-name pools), merchant-reply %, helpful-vote long-tail,
  backdated date range, variant assignment, rating-coherent structured attributes, and
  status at creation. Over 36 persona/style briefs keep the output varied. Every batch is
  tracked: the page lists existing batches with **View in Reviews** and **Delete batch**,
  plus **Delete ALL synthetic reviews** behind a typed double-confirmation; deletions
  re-sync product ratings.
- **Admin surfacing of review provenance**: a blue **Synthetic** badge on synthetic rows in
  the Reviews list, a **Source** filter (Storefront / CSV import / Bulk add / Synthetic —
  reviews from before 1.4 count as Storefront), a `?batch=` filter chip ("Batch: xxxxxxxx")
  behind the QA page's "View in Reviews" links, an info banner on synthetic reviews' detail
  pages (source, copyable batch id, generated timestamp, "View batch"), and a Dashboard
  banner whenever published synthetic reviews exist — informational while the store is not
  live, **critical** once it is ("… visible to real shoppers — delete them before customers
  see them."), linking to the QA data page.

### Schema

- Four new `Review` columns — `isSynthetic`, `source`, `syntheticBatchId`,
  `syntheticGeneratedAt` — plus an index on `(shop, isSynthetic)`, via migration
  `prisma/migrations/20260723150000_add_synthetic_source/`. No backfill: a NULL `source`
  marks pre-1.4 rows and the admin treats it as "storefront". Storefront submissions record
  `source: "storefront"` going forward. These columns are admin-only and are **never**
  serialized into storefront DTOs or proxy responses — shoppers cannot tell a synthetic
  review from a real one, which is why the Dashboard warns until every batch is deleted.

Storefront and proxy behavior are otherwise byte-identical to 1.3 across all three design
versions. No new dependencies, no locale-file changes.

## 1.3.0 — 2026-07-23

### Added

- **Third design version: Luxe**, selectable in **Settings → Design** as
  **"Luxe — premium skincare"** (with its own inline preview swatches; see
  `docs/CONFIGURATION.md`, "Design"): the same trusted layout, structure, spacing and behavior
  as the other two versions, styled like a premium skincare brand's own component — warm
  porcelain neutrals (`#F5F1EA`) on soft surfaces (chip panel, brand replies, form pills),
  champagne-gold (`#C8A24B`) stars and distribution bars, refined serif headings in normal
  case, small uppercase micro-labels, soft rectangles instead of pills (white buttons with a
  hairline border — solid ink for Submit review), a champagne Verified Purchase chip, and ink
  links underlined in gold. Deliberately **not** the clinical monochrome of the Cellexia
  version, yet warm enough in its neutrals to sit harmoniously next to cellexialabs.com.
- Wiring: `luxe` added to the design-theme allowlist (`DESIGN_THEMES`) — the existing
  `designTheme` column is plain text, so **no database migration** — a third ChoiceList option
  in the Settings → Design card, the Liquid skin guards in both blocks accept `luxe`, and one
  clearly-delimited CSS-only skin section appended to `cellexia-reviews.css` (same
  `data-cx-skin` mechanics as 1.1, including the themed dialog/sheet/lightbox surfaces).
- Demo page: a third "Luxe" button in the design switcher of `demo/index.html`.

No visual or behavioral change to the Amazon or Cellexia designs. No new dependencies, no new
storefront strings, no locale-file changes.

## 1.2.0 — 2026-07-23

### Added

- **Safe install, live-theme preview & explicit go-live.** Installing the app now makes zero
  visible change to the live storefront: a new install starts **Not live**, and until the
  merchant goes live, visitors get no widget, no review data (the storefront API answers 403)
  and no JSON-LD.
  - **Go live / Switch off**: a status banner at the top of the Dashboard shows the current
    state ("Not live yet — store visitors can't see the review widget." / "Live — visitors can
    see the review widget.") with confirmed one-click actions to switch either way. Switching
    off keeps all data. Settings → General shows a read-only "Storefront status" badge that
    links to the Dashboard.
  - **Preview on your store**: opens a product page on the real live theme in a new tab, with
    the full widget working and a "Preview mode" ribbon at the bottom — visible only in that
    browser (the link carries a private token). Works while live too. **Regenerate preview
    link** (Settings → Data) invalidates previously shared links.
  - The **theme editor always shows the full widget**, live or not, so blocks can be placed and
    configured before anything is visible to shoppers; the setup guide gains step 4
    "Preview, then go live".
  - Wiring: `Setting.isLive` (default `false` for new installs) + `Setting.previewToken`
    columns via migration `prisma/migrations/20260723120000_add_live_preview/`, shop metafield
    `cellexia.live` synced at install and on every switch, server-side gating on all five proxy
    routes, and three new storefront strings (`preview.badge`, `preview.note`, `preview.exit`)
    translated in all 17 languages.

### Upgrade note

- **Existing installations remain live automatically.** The migration backfills
  `isLive = true` for every store already running 1.0/1.1, and the storefront treats a missing
  `cellexia.live` shop metafield as live — upgrading cannot hide a widget that shoppers already
  see. Details in `docs/UPDATE.md`.

While a store is live, the widget behaves exactly as in 1.1 — no visual or behavioral change
for either design version. No new dependencies.

## 1.1.0 — 2026-07-23

### Added

- **Two design versions** for the storefront widget, selectable in **Settings → Design** (new
  card with inline preview swatches per option; see `docs/CONFIGURATION.md`, "Design"):
  - **Amazon like** — the v1.0 design, pixel-identical, still the default.
  - **Cellexia** — identical layout, structure, spacing and behavior, restyled to match
    cellexialabs.com: ink (`#1D1D1B`) text, stars and buttons; pale periwinkle (`#B1CDED`)
    accents on distribution bars, the Verified Purchase chip and brand replies; uppercase
    Gobold headings; fully-rounded pill buttons and outlined pill topic chips; underlined
    ink links.
- Wiring: `Setting.designTheme` column (default `"amazon"`) with migration, `designTheme` in
  the settings API ride-along, shop metafield `cellexia.design_theme` synced on save (the
  storefront picks the change up within about a minute), `data-cx-skin` attribute on the
  widget root and on dialog/sheet/lightbox surfaces, and one clearly-delimited CSS-only skin
  section at the end of `cellexia-reviews.css`.
- Demo page: "Amazon like" / "Cellexia" switcher in the banner of `demo/index.html` to preview
  both designs offline.

No visual or behavioral change to the Amazon design. No new dependencies, no new storefront
strings, no locale-file changes.

## 1.0.0 — 2026-07-23

Initial release.

### Storefront (theme app extension)

- "Cellexia Reviews" app block for product pages: SSR rating header (average, count, clickable
  star distribution), "Customers say" AI summary with topic chips and topic detail panel,
  customer photo/video strip with lightbox, search, sort (Top reviews / Most recent), filter
  panel (stars, verified, media, age range, skin concerns, time using, results seen), review
  cards with Verified Purchase badge, helpful votes, report dialog, brand replies, per-review
  and translate-all review translation, "See more reviews" pagination, write-a-review dialog
  with structured questions and media upload.
- "Cellexia Star Badge" app block: stars + average + ratings-count link that scrolls to the
  widget. SSR-only, renders nothing until the product has reviews.
- 17 storefront languages (en, fr, de, da, sv, fi, nl, it, es, ar, pl, pt-PT, ja, nb, ro, hu, el)
  with full RTL layout for Arabic.
- Product JSON-LD (aggregateRating + top reviews) for Google star rich snippets, guarded so it
  only renders when the product has ratings and the merchant has not disabled it.
- Accessibility: keyboard operability, focus-trapped dialogs, aria-live list updates,
  `prefers-reduced-motion` support.

### Admin (embedded, Polaris)

- Dashboard: setup guide, stat cards, "Needs attention" moderation queue, per-product table with
  AI summary regeneration.
- Reviews: filterable/searchable index with tabs per status, bulk Approve / Reject / Mark spam /
  Delete, review detail page with media previews, verification details, reply editor and
  translation preview.
- Import / Export: CSV export; CSV import with Judge.me / Loox / Yotpo / Generic presets and
  dry-run preview.
- Settings: general, AI summary (Anthropic key, model, auto-regen threshold), translation
  provider (Anthropic / DeepL / Google / off), display toggles, data export / delete.

### Platform

- App proxy JSON API under `/apps/cellexia/api/*` with HMAC signature verification and
  per-IP rate limits.
- Product metafields (namespace `cellexia`) for instant SSR and SEO.
- Review media uploaded to Shopify Files via staged uploads.
- Verified purchase detection (logged-in customer or order lookup by email).
- Webhooks: `app/uninstalled` plus GDPR (`customers/data_request`, `customers/redact`,
  `shop/redact`).
- Prisma + SQLite (Postgres switch documented), locale CI check (`npm run check:locales`),
  release packaging (`npm run package`), standalone visual demo (`demo/index.html`).
