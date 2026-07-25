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
- **Safe install, private preview, explicit go-live**: installing changes nothing on the live
  storefront — a new install starts **Not live**, so visitors see no widget, no review data and
  no JSON-LD until you click **Go live** on the Dashboard. Before (and after) that,
  **Preview on your store** opens a tokenized preview of the widget on the real live theme that
  only you can see, and the theme editor always shows the full widget so you can place and
  configure the blocks. Enforced server-side: while not live, the storefront API rejects
  requests without a valid preview token.
- **Star badge block** for placement under the product title (SSR-only, links to the widget).
- **App embed with site-wide star badges**: for themes that don't accept app blocks on product
  templates, one toggle in the theme editor (Theme settings → App embeds) mounts the full
  widget on every product page automatically — with an optional CSS-selector placement
  override — and can show stars under the product page's own title. It also injects **star
  badges next to product names on product cards across the whole store** (home, collections,
  search, featured sections) for products with published reviews: one batched, cached request
  per page, automatic card detection with an advanced selector override, all three design
  versions applied. Same Not-live/preview gating as everything else; the blocks stay preferred
  where the theme supports them and never double-render alongside the embed.
- **17 storefront languages** shipped: en, fr, de, da, sv, fi, nl, it, es, ar, pl, pt-PT, ja, nb,
  ro, hu, el — including full RTL support for Arabic.
- **AI summary & topics**: Claude (Messages API, default model `claude-sonnet-5`) condenses up to
  200 published reviews into a summary plus up to 8 sentiment-scored topic chips.
- **On-demand review translation** for shoppers: Anthropic (default), DeepL, or Google — or off.
  All AI features degrade gracefully when no key is configured.
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
  and the design versions — fully parameterized (count, target average rating with a derived
  star distribution, verified %, languages, merchant-reply %, helpful votes, backdated date
  range, variants, structured attributes). Internally flagged and batch-tracked: a **Synthetic**
  badge and Source filter in the admin, a Dashboard warning while any are published (critical
  once the store is live), and one-click batch deletion. Synthetic reviews are **never** labeled
  on the storefront — delete every batch before going live.
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

- **App proxy**: storefront calls `/apps/cellexia-reviews/api/*` on the shop domain; Shopify
  signs and forwards them to `/proxy/api/*` on this app. See `app/routes/proxy.api.*` and
  `app/services/proxy.server.ts`. The storefront-side path is single-sourced in
  `extensions/cellexia-reviews/snippets/cx-proxy.liquid` and must match `[app_proxy]` in
  `shopify.app.toml`.
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
                     rate limiting
  components/admin/  Polaris components used by the admin routes
  types/cellexia.ts  Shared constants (option keys, statuses, locales) and DTO types
extensions/
  cellexia-reviews/  Theme app extension: blocks (reviews, star-rating, app embed), snippets
                     (stars, i18n bridge, JSON-LD), assets (1 CSS + 1 JS file),
                     locales (17 languages, storefront + schema files)
prisma/              schema.prisma (Session, Review, ReviewMedia, Vote, Summary,
                     TranslationCache, Setting) + seed.js demo seeder
scripts/             check-locales.mjs (CI locale validation), package.mjs (release ZIP)
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
| `npm run package` | Build the release ZIP in `dist/` |
| `npm run typecheck` | `tsc --noEmit` |

## Documentation

| Doc | Audience | Contents |
| --- | --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Developer | Full install: app creation, hosting (Render / Fly.io / Railway), env vars, app proxy, theme editor, verification checklist |
| [docs/UPDATE.md](docs/UPDATE.md) | Developer | How to apply a new release ZIP safely |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Developer | One-page brief: what you are receiving and what to provision |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Merchant | Every admin setting, going live & previewing, app embed & star badges, moderation, replies, CSV import, bulk add, QA data (synthetic reviews), API keys |
| [docs/TRANSLATIONS.md](docs/TRANSLATIONS.md) | Both | The 17 locales, editing strings, Translate & Adapt, review translation, RTL |
| [docs/SEO.md](docs/SEO.md) | Both | Star rich snippets: how they work, validation, duplicate JSON-LD note |
| [docs/FAQ.md](docs/FAQ.md) | Merchant | Theme safety, uninstall, GDPR, media limits, rate limits |
| [demo/README.md](demo/README.md) | Both | How to open the offline visual demo |
| [CHANGELOG.md](CHANGELOG.md) | Both | Version history |

## Version

Current version: **1.5.1** — see [CHANGELOG.md](CHANGELOG.md).
