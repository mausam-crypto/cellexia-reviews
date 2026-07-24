# Changelog

All notable changes to Cellexia Reviews are documented here. The version number is read from
`package.json` and stamped into the release ZIP built by `npm run package`
(`dist/cellexia-reviews-v<version>.zip`).

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
