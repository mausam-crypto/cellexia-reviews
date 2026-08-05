# Handover brief

One page for the developer taking delivery of Cellexia Reviews. Read this first, then follow
`docs/INSTALL.md`.

## What you are receiving

A complete, self-hosted **custom Shopify review app** for the Cellexia store:

- **This repository** (or its release ZIP `dist/cellexia-reviews-v<version>.zip`): a Remix
  backend (official Shopify app template structure), a theme app extension with four storefront
  app blocks and an app embed, 17 storefront languages, Prisma database schema, Dockerfile,
  docs.
- **Storefront**: Amazon-style review widget + star badge, added as app blocks in the theme
  editor — or, on themes that refuse blocks on product templates, as a one-toggle app embed that
  also badges product cards site-wide. Zero theme-code edits either way, uninstall-safe. Three
  merchant-selectable design versions (Amazon like / Cellexia / Luxe — switched in Settings,
  previewable offline via `demo/index.html`).
- **Self-verifying**: a Storefront connection card on the Dashboard proves the whole storefront
  pipeline end to end (proxy, secret, preview token, extension activity, review data, metafield
  sync, database, live state) before go-live, with a terminal equivalent (`npm run selftest`).
  The app-proxy subpath is auto-detected and mirrored to a shop metafield, so the storefront
  path cannot drift from `shopify.app.toml`. Shoppers never see an error box: on a live store a
  failing widget hides itself, and diagnostics appear only in the theme editor and preview.
- **Safe by default**: a fresh install is **Not live** — visitors see nothing until the
  merchant clicks Go live; a tokenized "Preview on your store" button shows the widget on the
  real theme privately first.
- **Admin**: embedded Polaris app — Dashboard (status banner, setup guide, stats, moderation
  queue), Reviews (moderation + brand replies), Bulk add (manual multi-review entry incl.
  image/video media), Import / Export (CSV with template download and Judge.me / Loox / Yotpo
  presets), QA data (synthetic test-review generator with batch cleanup), Settings.
- **AI**: Claude API summaries/topic chips, review translation, and the QA generator (all work
  without any key — those features simply don't activate until a key is added in Settings).
- **SEO**: product metafields + JSON-LD for Google star rich snippets (suppressed while not
  live).

Nothing here is on the Shopify App Store; it is a single-store custom app you deploy and
install yourself.

## What you must provision

| Item | Options | Notes |
| --- | --- | --- |
| Hosting for the backend | Render / Fly.io / Railway | Dockerfile provided; step-by-step walkthroughs in `docs/INSTALL.md` §5. Smallest paid instance is fine; run one instance. |
| Database | SQLite on a 1 GB volume (default) or Postgres | One documented edit in `prisma/schema.prisma` to switch. |
| Shopify app entry | Your Partner account | Created by `npm run config:link`; installed on the store via a custom-distribution link. |
| Protected customer data access | Partner Dashboard → your app → API access | Needed for `read_orders` (verified-purchase badges) on live stores. |
| Anthropic API key | console.anthropic.com | Optional; merchant pastes it into the app's Settings. DeepL/Google keys likewise, only if chosen as translation provider. |

## Expected effort

About **half a day**: 1–2 h hosting + deploy, ~30 min Shopify config and install, ~30 min theme
editor + verification checklist, the rest buffer. No coding is required for a standard install.

## Your runbook

1. `docs/INSTALL.md` — end-to-end install, env var table, hosting walkthroughs, final checklist
   (§10 starts with the storefront connection test and `npm run selftest`; §11 maps every
   anticipated symptom to its fix).
2. `docs/UPDATE.md` — how future release ZIPs are applied (5 fixed steps), what is safe to
   customize, backup and rollback.
3. `docs/SEO.md` — validate rich snippets; check the duplicate JSON-LD note against the
   store's theme.
4. Hand `docs/CONFIGURATION.md` and `docs/FAQ.md` to the merchant.

## Support checklist (what "healthy" looks like)

- **Dashboard → Storefront connection → Run test again** reads "Storefront connection verified"
  (or only the two benign warnings: no storefront hit yet on a brand-new install, no reviews
  yet). This single check covers the app proxy, the API secret, the preview token, the theme
  extension, review data, metafield sync, database persistence and live state — start every
  support conversation here. From a terminal, the proxy half of it is
  `npm run selftest -- --shop=<store>.myshopify.com`, and
  `https://<shop-domain>/apps/<subpath>/api/ping` answers
  `{"ok":true,"app":"cellexia-reviews",…}` at any time, live or not.
- `https://<shop-domain>/apps/cellexia-reviews/api/reviews?product_id=<id>` returns full JSON
  once the store is live. Before go-live it answers `{"ok":false,"errors":{"_":"not_live"}}`
  (HTTP 403) — itself a pass signal, because that JSON is the app's own: the request was
  signed by Shopify, forwarded, and verified with the API secret.
- Embedded admin loads; Dashboard shows stats.
- New storefront submissions appear as Pending; approving them updates the storefront header
  and star badge.
- `npm run check:locales` exits 0 after any locale edits.
- Backend logs are clean on the hosting dashboard; database volume/Postgres has free space.
- Keys/secrets live only in hosting env vars (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
  `SHOPIFY_APP_URL`, `SCOPES`, optionally `DATABASE_URL`) — never committed.
  `CELLEXIA_ALLOW_UNSIGNED` must not be set in production.

## Known limits to communicate to the merchant

- The app shows only the reviews stored **in it**. Reviews still held by a previous review app
  are invisible until imported (Import / Export) — so a fresh install legitimately shows no
  stars anywhere. Set this expectation at handover; the Dashboard's *Review data* check says the
  same thing.
- One backend instance (SQLite + in-memory rate limiting) — plenty for a single store.
- CSV-imported reviews reference media by external URL (Bulk add uploads, by contrast, go to
  Shopify's CDN).
- AI summary appears once a product has enough published reviews (default threshold: 5).
- Google decides if/when star snippets show; the app provides valid structured data
  (`docs/SEO.md`).
- Synthetic QA reviews look completely real on the storefront (labeled only in the admin) —
  the Dashboard warns if any are published while the store is live; delete every batch before
  launch.
