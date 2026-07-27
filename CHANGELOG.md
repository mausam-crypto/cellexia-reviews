# Changelog

All notable changes to Cellexia Reviews are documented here. The version number is read from
`package.json` and stamped into the release ZIP built by `npm run package`
(`dist/cellexia-reviews-v<version>.zip`).

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
