# Handover brief

One page for the developer taking delivery of Cellexia Reviews. Read this first, then follow
`docs/INSTALL.md`.

## What you are receiving

A complete, self-hosted **custom Shopify review app** for the Cellexia store:

- **This repository** (or its release ZIP `dist/cellexia-reviews-v<version>.zip`): a Remix
  backend (official Shopify app template structure), a theme app extension with two storefront
  app blocks, 17 storefront languages, Prisma database schema, Dockerfile, docs.
- **Storefront**: Amazon-style review widget + star badge, added as app blocks in the theme
  editor — zero theme-code edits, uninstall-safe. Three merchant-selectable design versions
  (Amazon like / Cellexia / Luxe — switched in Settings, previewable offline via
  `demo/index.html`).
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

1. `docs/INSTALL.md` — end-to-end install, env var table, hosting walkthroughs, final checklist.
2. `docs/UPDATE.md` — how future release ZIPs are applied (5 fixed steps), what is safe to
   customize, backup and rollback.
3. `docs/SEO.md` — validate rich snippets; check the duplicate JSON-LD note against the
   store's theme.
4. Hand `docs/CONFIGURATION.md` and `docs/FAQ.md` to the merchant.

## Support checklist (what "healthy" looks like)

- `https://<shop-domain>/apps/cellexia/api/reviews?product_id=<id>` returns JSON.
- Embedded admin loads; Dashboard shows stats.
- New storefront submissions appear as Pending; approving them updates the storefront header
  and star badge.
- `npm run check:locales` exits 0 after any locale edits.
- Backend logs are clean on the hosting dashboard; database volume/Postgres has free space.
- Keys/secrets live only in hosting env vars (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
  `SHOPIFY_APP_URL`, `SCOPES`, optionally `DATABASE_URL`) — never committed.
  `CELLEXIA_ALLOW_UNSIGNED` must not be set in production.

## Known limits to communicate to the merchant

- One backend instance (SQLite + in-memory rate limiting) — plenty for a single store.
- CSV-imported reviews reference media by external URL (Bulk add uploads, by contrast, go to
  Shopify's CDN).
- AI summary appears once a product has enough published reviews (default threshold: 5).
- Google decides if/when star snippets show; the app provides valid structured data
  (`docs/SEO.md`).
- Synthetic QA reviews look completely real on the storefront (labeled only in the admin) —
  the Dashboard warns if any are published while the store is live; delete every batch before
  launch.
