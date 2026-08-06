# Cellexia Reviews

Custom Shopify product-review app for **Cellexia** (anti-aging skincare). Amazon-grade review UI
on the storefront, full moderation suite in the Shopify admin, AI review summaries and
translations powered by the Claude API, and Google star rich snippets out of the box.

Built on the official Shopify Remix app template (`@shopify/shopify-app-remix`) with a theme app
extension — no theme code edits, uninstall-safe.

## Features

- **Amazon-fidelity review widget** (app block): rating header with clickable star distribution,
  "Customers say" AI summary with topic chips, customer photo/video strip with lightbox,
  search / sort / filter controls, review cards with Verified Purchase badges, helpful votes,
  report flow, brand replies, and a full write-a-review dialog with structured skincare questions
  (age range, skin concerns, time using, results seen).
- **Three design versions**, switchable storefront-wide in Settings → Design: **Amazon like**
  (default — the layout above, unchanged), **Cellexia** — the exact same layout and behavior
  restyled to match cellexialabs.com (ink & periwinkle palette, uppercase Gobold headings, pill
  buttons and chips) — or **Luxe** — the same layout again with the warmth of a premium skincare
  brand (porcelain neutrals, champagne-gold stars, refined serif headings, soft rectangles).
  Pure CSS skins via a `data-cx-skin` attribute, synced to the storefront through a shop
  metafield (`cellexia.design_theme`).
- **Market-scoped go-live with a Stamped takeover** (since 1.14.0): go live in selected
  Shopify Markets only — the per-market decision is made by Shopify's own page rendering
  (`localization.market`), never by client-side geo guessing, so unselected markets keep a
  byte-for-byte unchanged storefront. Optionally hide the incumbent Stamped reviews (PDP
  widget + its stars under product names on product/home/collection pages) in exactly the
  markets where Cellexia Reviews is live: CSS-only, instantly reversible, previewable per
  tab before going live, with selector defaults measured from the real theme and an
  admin override. Market picking works with zero extra API scopes (handles register
  themselves from storefront visits; `read_markets` optionally adds names).
- **Safe install, private preview, explicit go-live**: installing changes nothing on the live
  storefront — a new install starts **Not live**, so visitors see no widget, no review data and
  no JSON-LD until you click **Go live** on the Dashboard. Before (and after) that,
  **Preview on your store** opens a tokenized preview on the real live theme that only you can
  see — a three-destination menu since 1.10.0 (**Product page**, **Home page**,
  **Collection page**), covering every surface: widget, card badges and the Overall reviews
  block. The preview follows you across pages in the same tab (the token is captured on any
  page with a Cellexia surface and remembered by the tab), the ribbon and **Exit preview**
  work on every page, and an expired token says so instead of going silently blank. The theme
  editor always shows the full widget — with real review data, because the preview token is
  mirrored to the theme in design mode only — so you can place and configure the blocks.
  Enforced server-side: while not live, the storefront API rejects requests without a valid
  preview token.
- **Self-verifying install**: a **Storefront connection** card at the top of the Dashboard tests
  the whole storefront pipeline on demand — app proxy reachable (and on which subpath), preview
  token round-trip, theme-extension activity, review data, metafield sync, database persistence,
  live state — each check with a plain-language fix, an overall "Storefront connection verified"
  banner, and a warning in the Go live confirmation while anything fails. The same probe runs
  from a terminal via `npm run selftest -- --shop=<store>.myshopify.com`. The proxy subpath is
  auto-detected and mirrored to a shop metafield, so the storefront path can never drift out of
  sync with `shopify.app.toml`, and the widget re-discovers it client-side if a request 404s.
- **Failure UX split by audience**: a shopper on a live store never sees an error box, a notice
  or a preview token — the widget hides itself quietly. Merchants (theme editor or preview) get
  an explicit inline notice instead: expired preview session, unconfigured storefront connection,
  or a Try again action; content already rendered is never replaced by an error.
- **Star badge block** for placement under the product title (SSR-only, links to the widget).
- **App embed with site-wide star badges**: for themes that don't accept app blocks on product
  templates, one toggle in the theme editor (Theme settings → App embeds) mounts the full
  widget on every product page automatically — with an optional CSS-selector placement
  override — and can show an **Amazon-exact rating badge under the product page's own
  title** (since 1.12.0): the average ("4.6"), stars rounded to the nearest half exactly like
  Amazon, a caret, and the review count as a link — with a **ratings-breakdown popover**
  (stars + "4.6 out of 5", "1,936 global ratings", the 5→1 star meter rows, and "See customer
  reviews") that opens on click or hover, closes via X / Escape / tapping outside, clamps
  itself inside the viewport on mobile, and whose star rows jump to the review list filtered
  to that rating. Positioned **directly under the title** (the default) or **under the
  tagline**, with its own CSS-selector override for exact placement (safe fallbacks: a
  missing tagline or unmatched selector falls back to under the title, never a missing row).
  It also injects **star
  badges next to product names on product cards across the whole store** (home, collections,
  search, featured sections) for products with published reviews: one batched, cached request
  per page, automatic card detection with an advanced selector override, all three design
  versions applied. Same Not-live/preview gating as everything else; the blocks stay preferred
  where the theme supports them and never double-render alongside the embed.
- **Overall reviews block (brand-wide)**: an optional **Cellexia Overall Reviews** theme block
  for the home page (or any sections-enabled page) showing the brand's combined rating across
  **all** products — large star row, "Based on N reviews across our products", a "% from
  verified purchases" trust line (shown when the verified share is at least 60%), optional
  clickable distribution bars (filter to one star level, **All stars** chip to reset), and top
  reviews across products as condensed cards — grid or swipeable carousel — each linking to its
  product's review section, plus an optional CTA button. Rendered fully server-side from two
  shop metafields (zero API calls on first paint, cheap debounced re-sync as reviews change),
  with review selection controlled from the admin: an **Auto** ranking (strongest recent
  reviews, max 2 per product for diversity) or up to 12 **hand-picked** reviews in an explicit
  order with auto backfill, a **Refresh homepage data** button, and a one-click **Feature on
  homepage** action on each review's page. Deliberately emits **no JSON-LD** (Google ignores
  self-serving organization ratings — see `docs/SEO.md`); same not-live/preview gating as
  everything else. For shoppers, a shop with zero published reviews renders nothing at all —
  while merchants (theme editor or preview) never get a silent blank since 1.10.0: before the
  first metafield sync the block renders itself from live data client-side, a genuinely
  zero-review store shows a merchant-only note instead, and the app re-syncs the shop
  snapshot best-effort on every (re)authentication.
- **Review display order** (new **Display order** page in the admin navigation): control which
  reviews shoppers see first. A store-wide default ranking chosen from six systems — the
  Amazon-style helpfulness ranking (still the default, and exactly the previous behavior),
  top positive first, most recent first, Verified Purchases first, photos & videos first, or a
  balanced mix that alternates three positive reviews with one critical — plus optional boosts
  (**Show Verified Purchase reviews first** / **Show reviews with photos first**), per-product
  overrides, and up to **10 hand-picked featured reviews per product** shown first in an explicit
  order, with a one-click **Feature on product page** action right on each review's moderation
  page. Featured reviews and the chosen system also drive the server-rendered top reviews and
  the Google structured data; shoppers can still re-sort and filter, and display changes reach
  the storefront within a minute.
- **17 storefront languages** shipped: en, fr, de, da, sv, fi, nl, it, es, ar, pl, pt-PT, ja, nb,
  ro, hu, el — including full RTL support for Arabic.
- **AI summary & topics**: Claude (Messages API, default model `claude-sonnet-5`) condenses up to
  200 published reviews into a summary plus up to 8 sentiment-scored topic chips.
- **Review translation** for shoppers: Anthropic (default), DeepL, or Google — or off. A
  translation display mode (Settings → Translation) chooses how reviews written in another
  language appear: in their original language with a per-review Translate button (the default),
  or automatically translated into the shopper's language with a "Translated from …" note and
  **See original** / **See translation** toggles. Translations are created once per language,
  cached, and shared by every later visitor. Translated text is kept in a real shopper's
  register: the translator is instructed to preserve each reviewer's casual tone and to avoid
  AI-flavored wording, and every served translation passes a deterministic em/en-dash scrub
  (locale-aware — ideographic comma for Japanese, Arabic comma for Arabic; number ranges like
  "2–3 weeks" become plain hyphens, "2-3 weeks") regardless of provider, including
  translations cached before 1.11.0. Reviews shown in their original language are never
  altered. All AI features degrade gracefully when no key is
  configured — automatic mode simply falls back to the original language, never an error.
- **Moderation**: pending/published/rejected/spam workflow, bulk actions, report auto-remoderation,
  brand replies, per-review translation preview for the merchant.
- **Verified purchase detection** via logged-in customer id or order lookup by email.
- **Review media** uploaded to Shopify Files (up to 5 images + 1 video per review), served from
  the Shopify CDN.
- **SEO**: aggregate rating, distribution, top reviews and summary are stored in product
  metafields (namespace `cellexia`) so Liquid renders instantly server-side and emits Product
  JSON-LD for Google star rich snippets.
- **Import / Export**: CSV export with a round-trip-ready column set, and a guarded CSV import:
  downloadable generic template, Judge.me / Loox / Yotpo presets auto-detected from the file's
  headers, a date-format select for ambiguous dates, full-file validation with a per-row error
  report, duplicate skipping, and chunked import with a progress bar for large files.
- **Bulk add**: enter many reviews for a product directly in the admin — star rating, structured
  answers, replies and media (file uploads to Shopify Files or external URLs) — staged in an
  editable list and saved in chunks with per-row error reporting.
- **Synthetic QA review generator**: AI-generated realistic test reviews for QA of the widget
  and the design versions — fully parameterized (count — uncapped since 1.7.0 — target average
  rating with a derived star distribution, verified %, languages, merchant-reply %, helpful
  votes, backdated date range, variants, structured attributes — and, since 1.10.0,
  per-language and per-variant **percentage share editors**: even-split prefill, a live
  "Total: N%" check that must reach 100%, deterministic exact counts interleaved across the
  batch; the pre-1.10 jittered defaults apply only when an editor is not shown, while a visible
  editor's percentages are applied exactly as displayed). Generated text ships with no em/en dashes — a
  telltale of AI writing that real shoppers rarely type — scrubbed at every layer since
  1.10.0, hyphens untouched. Generation runs as
  **server-side background jobs**: leave the page or close the tab, run several jobs at once,
  and follow progress from any admin page via a global activity banner. An optional
  **Estimate cost** button predicts token usage, USD cost and duration before a run (durations
  calibrated from the store's own measured throughput, Anthropic pricing incl. the Sonnet 5
  introductory rate while it applies), and each job reports its actual cost from real token
  usage once finished; jobs can be cancelled (keeping what they made) or retried for the
  remainder, and they survive an app restart without overshooting. Internally flagged and
  batch-tracked: a **Synthetic** badge and Source filter in the admin, a Dashboard warning
  while any are published (critical once the store is live), and one-click batch deletion.
  Synthetic reviews are **never** labeled on the storefront — delete every batch before going
  live.
- **Anti-abuse**: app-proxy HMAC verification, honeypot + minimum fill time on the form,
  per-IP rate limits, server-side media re-validation.

## Architecture

```
                 Shopper's browser
                        │
        ┌───────────────┴────────────────┐
        │  Storefront (merchant theme)   │
        │  Theme app extension blocks:   │
        │   • reviews.liquid  (widget)   │
        │   • star-rating.liquid (badge) │
        │   • embed.liquid (app embed:   │
        │     auto-widget + card badges) │
        │   • overall-reviews.liquid     │
        │     (brand-wide, home page)    │
        │  SSR from product metafields   │
        │  + cellexia-reviews.js/css     │
        └───────┬────────────────────────┘
                │  fetch /apps/cellexia-reviews/api/*
                ▼
     ┌──────────────────────┐   app proxy (HMAC-signed)
     │   Shopify platform   │ ─────────────────────────┐
     │  (proxy, CDN, admin) │                          │
     └─────────┬────────────┘                          ▼
               │ embedded admin (Polaris)   ┌─────────────────────────┐
               ▼                            │  Remix app (this repo)  │
     ┌──────────────────────┐               │  /app/*   admin UI      │
     │  Merchant's admin    │ ────────────► │  /proxy/* storefront API│
     └──────────────────────┘               │  services + Prisma      │
                                            └──────┬───────────┬──────┘
                                                   │           │
                                     SQLite/Postgres│           │ Admin GraphQL
                                          (Prisma)  │           │ (metafields, Files,
                                                    ▼           ▼  orders, webhooks)
                                              ┌─────────┐  ┌──────────┐
                                              │ Database│  │ Shopify  │
                                              └─────────┘  └──────────┘
                                                    │
                                                    ▼
                                          Claude API / DeepL / Google
                                          (summary + translations)
```

- **App proxy**: storefront calls `/apps/<subpath>/api/*` on the shop domain; Shopify signs and
  forwards them to `/proxy/api/*` on this app. See `app/routes/proxy.api.*` and
  `app/services/proxy.server.ts`. The subpath is **discovered, not configured twice**:
  `app/services/proxyhealth.server.ts` probes `/apps/<candidate>/api/ping`, persists the winner
  and mirrors it to the shop metafield `cellexia.proxy_path`, which
  `extensions/cellexia-reviews/snippets/cx-proxy.liquid` reads (default `cellexia-reviews`). The
  storefront path therefore always follows `[app_proxy]` in `shopify.app.toml`.
- **Metafields** (namespace `cellexia`: `rating`, `rating_count`, `distribution`, `top_reviews`,
  `summary`) make the widget paint server-side with no JavaScript and power JSON-LD.
- **Database**: Prisma + SQLite by default, identical to the official template; switching to
  Postgres is a documented change in `prisma/schema.prisma` (see `docs/INSTALL.md`).

## Repository layout

```
app/
  routes/            Remix routes: /app/* (embedded admin), /proxy/api/* (storefront JSON API),
                     auth, webhooks (app/uninstalled + GDPR)
  services/          Business logic: reviews, aggregates, metafields, verified purchase,
                     AI summary, translation, Shopify Files uploads, settings, proxy HMAC,
                     rate limiting, storefront health check + proxy-subpath discovery
  components/admin/  Polaris components used by the admin routes
  types/cellexia.ts  Shared constants (option keys, statuses, locales) and DTO types
extensions/
  cellexia-reviews/  Theme app extension: blocks (reviews, star-rating, app embed,
                     overall reviews), snippets
                     (stars, i18n bridge, JSON-LD), assets (1 CSS + 1 JS file),
                     locales (17 languages, storefront + schema files)
prisma/              schema.prisma (Session, Review, ReviewMedia, Vote, Summary,
                     TranslationCache, Setting) + seed.js demo seeder
scripts/             check-locales.mjs (CI locale validation), package.mjs (release ZIP),
                     selftest.mjs (app-proxy probe from the command line)
demo/                Standalone visual preview of the widget with mock data (no Shopify needed)
docs/                Documentation (see quick links below)
Dockerfile           node:20-alpine production image
shopify.app.example.toml  App configuration template (incl. [app_proxy]) — copy, then link
```

## Requirements

- Node.js 20.10+, 22 LTS, or 23.3+ (Node 21 and 23.0–23.2 are unsupported — see `.nvmrc`)
- Shopify CLI (latest)
- A Shopify Partner account and a store to install on
- A hosting account (Render, Fly.io, or Railway — walkthroughs provided)
- Optional: Anthropic API key (AI summary + translations), DeepL or Google Translate API key

## Quick start (development)

```bash
npm install
cp .env.example .env
cp shopify.app.example.toml shopify.app.toml
npm run config:link   # create/link the app on your Partner account
npm run dev           # tunnels, hot-reloads, serves the extension to a dev store
```

Full production installation, hosting and store setup: **[docs/INSTALL.md](docs/INSTALL.md)**.

## npm scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | `shopify app dev` — local development against a dev store |
| `npm run build` | `remix vite:build` — production build |
| `npm run start` | `remix-serve ./build/server/index.js` — run the built server |
| `npm run setup` | `prisma generate && prisma migrate deploy` — prepare the database |
| `npm run docker-start` | `setup` + `start` (used by the Dockerfile) |
| `npm run config:link` | `shopify app config link` — link `shopify.app.toml` to a Partner app |
| `npm run deploy` | `shopify app deploy` — push app config + theme extension to Shopify |
| `npm run seed:demo` | Insert ~15 demo reviews (`node prisma/seed.js --shop=<domain> --product=<id>`) |
| `npm run check:locales` | Validate all 17 locale files against the English master |
| `npm run selftest` | Probe the deployed app proxy from a terminal (`-- --shop=<domain>.myshopify.com`): PASS/FAIL per candidate subpath, no dependencies |
| `npm run package` | Build the release ZIP in `dist/` |
| `npm run typecheck` | `tsc --noEmit` |

## Documentation

| Doc | Audience | Contents |
| --- | --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Developer | Full install: app creation, hosting (Render / Fly.io / Railway), env vars, app proxy, theme editor, verification checklist |
| [docs/UPDATE.md](docs/UPDATE.md) | Developer | How to apply a new release ZIP safely |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Developer | One-page brief: what you are receiving and what to provision |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Merchant | Every admin setting, going live & previewing, app embed & star badges, overall reviews widget (brand-wide block), review display order & featured reviews, moderation, replies, CSV import, bulk add, QA data (synthetic reviews), API keys |
| [docs/TRANSLATIONS.md](docs/TRANSLATIONS.md) | Both | The 17 locales, editing strings, Translate & Adapt, review translation, RTL |
| [docs/SEO.md](docs/SEO.md) | Both | Star rich snippets: how they work, validation, duplicate JSON-LD note |
| [docs/FAQ.md](docs/FAQ.md) | Merchant | Theme safety, why no stars appear on a fresh install, preview-only messages, uninstall, GDPR, media limits, rate limits |
| [demo/README.md](demo/README.md) | Both | How to open the offline visual demo |
| [CHANGELOG.md](CHANGELOG.md) | Both | Version history |

## Version

Current version: **1.22.0** — see [CHANGELOG.md](CHANGELOG.md).
