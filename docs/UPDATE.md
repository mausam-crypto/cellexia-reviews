# Update guide

Audience: the developer maintaining a live installation. Read this before applying any new
release of Cellexia Reviews.

## How releases arrive

A release is a ZIP built with `npm run package`:
`cellexia-reviews-v<version>.zip`, containing the whole project under a top-level
`cellexia-reviews/` folder (no `node_modules`, no `.env*`, no databases, no `.git`).
`CHANGELOG.md` inside the ZIP tells you what changed; the version follows semver
(patch = fixes, minor = features, major = read the changelog carefully — may need config or
database attention).

## The update contract

Applying a release is always the same five steps:

```bash
# 0. Back up first (see below), then from your working copy of the live project:

# 1. Replace the project files with the new release
unzip cellexia-reviews-v<version>.zip
rsync -a --exclude '.env' --exclude 'shopify.app.toml' --exclude 'prisma/migrations/' \
      --exclude '*.sqlite*' cellexia-reviews/ ./
#    (or diff + copy by hand — the point: new code in, your local files in §"What survives" kept)

# 2. Install dependencies
npm install

# 3. Apply any new database migrations
npx prisma migrate deploy        # (this is also part of `npm run setup`)

# 4. Push the app config + theme extension to Shopify
npm run deploy

# 5. Redeploy the backend
#    Render / Railway: git commit + push (both build from your Git repo)
#    Fly.io:           fly deploy
```

Order matters: deploy the backend and the extension in the same maintenance window — the
extension's JS talks to the backend's JSON API and the two are versioned together.

Note on step 3: the container also runs `prisma migrate deploy` on every start
(`npm run docker-start`), so migrations shipped in the release are applied automatically when
the backend restarts. Running it locally first (against a copy) is still the safe way to spot a
failing migration before production does.

## Before every update: back up

- **Database**: SQLite — copy the `.sqlite` file from the volume (e.g.
  `fly ssh console -C "cat /data/production.sqlite" > backup.sqlite` or your host's disk
  snapshot). Postgres — `pg_dump`.
- **Reviews**: additionally, admin → Import / Export → **Export all reviews CSV**. Cheap
  insurance that survives anything.
- **Config**: keep copies of `.env` and `shopify.app.toml`.

## What survives an update (and what gets overwritten)

**Never overwritten by an update** (not in the ZIP):

| Item | Why it's safe |
| --- | --- |
| `.env` | Excluded from the release ZIP |
| `shopify.app.toml` | You created it from `shopify.app.example.toml`; the ZIP only ships the example |
| The database / `*.sqlite*` files | Excluded from the ZIP; migrations only alter schema |
| Hosting config (`fly.toml`, Render/Railway settings) | Lives on the platform / outside the ZIP where you created it |

**`prisma/migrations/` — protected by the rsync exclude, NOT by the ZIP:**

The release ZIP **does** ship the release's own migration history (`npm run package` does not
exclude `prisma/migrations/`). If you copy the release over your project without the
`--exclude 'prisma/migrations/'` flag from step 1, the release's folder replaces yours and any
migrations you generated locally are lost. The required procedure:

1. Always keep `--exclude 'prisma/migrations/'` in the step 1 rsync (or skip that folder when
   copying by hand).
2. Compare the release's `cellexia-reviews/prisma/migrations/` with your own
   `prisma/migrations/` and copy any **new** migration folders (and nothing else) into yours.
3. Step 3 (`npx prisma migrate deploy`) then applies exactly those newly copied migrations.

**Safe to customize — but re-apply after updates:**

| Item | Notes |
| --- | --- |
| Extension locale files (`extensions/cellexia-reviews/locales/*.json`) | The update ships new versions; if you edited wording, re-apply your edits, keep the key structure identical, and run `npm run check:locales`. Prefer the merchant-side paths in `docs/TRANSLATIONS.md`, which survive updates. |
| CSS design tokens (the `--cx-*` variables at the top of `extensions/cellexia-reviews/assets/cellexia-reviews.css`) | Token tweaks are easy to re-apply; the star accent color is better changed via the block setting in the theme editor (survives updates). |

**Overwritten by every update — do not hand-edit:**

- Everything under `app/` (routes, services, components)
- `extensions/cellexia-reviews/blocks/`, `snippets/`, `assets/*.js`
- `prisma/schema.prisma`, `scripts/`, `Dockerfile`, `package.json`

If you need a behavior change in those files, request it upstream so it lands in the next
release — local patches will be lost.

## Release-specific notes

### 1.2.0 — safe install / preview / go live

1.2.0 makes new installs start **Not live** (nothing shows on the storefront until the
merchant clicks **Go live** on the Dashboard) and adds a tokenized live-theme preview.
**Existing installations are not affected**: the release's migration
(`prisma/migrations/20260723120000_add_live_preview/`) backfills `isLive = true` for every
store already in the database, and the storefront treats a missing `cellexia.live` shop
metafield as live — so a store that was showing reviews before the update keeps showing them,
with zero action required from you or the merchant.

Two things to get right when applying this release:

1. **Copy the new migration folder.** Per the `prisma/migrations/` procedure above, copy
   `20260723120000_add_live_preview/` from the release into your own `prisma/migrations/`
   before step 3 — it is the migration that performs the live backfill.
2. **Verify after deploying**: the merchant's Dashboard banner should read
   "Live — visitors can see the review widget." and the product page should still show the
   widget. The Dashboard gains Preview / Switch off actions and Settings → Data gains
   "Regenerate preview link" — merchant-facing docs: `docs/CONFIGURATION.md`,
   "Going live & previewing".

**Untouched by updates (merchant-side state):**

- Block placement and block settings in the theme editor (heading, per page, accent color, toggles)
- Everything in the app's Settings page (API keys, providers, thresholds)
- Translate & Adapt translations of the block heading
- Product metafields (recomputed by the app as reviews change)

## After updating: verify

Run the short version of the install checklist (`docs/INSTALL.md` §10):

1. Embedded admin loads.
2. `https://<shop-domain>/apps/cellexia-reviews/api/reviews?product_id=<id>` returns JSON.
3. Product page widget renders and can load page 2 ("See more reviews").
4. `npm run check:locales` exits 0.
5. Skim `CHANGELOG.md` for feature-specific checks (e.g. a new setting to configure).

## Rollback

Keep the previous release ZIP. Rolling back = applying the old ZIP with the same five steps.
Caveat: if the new release shipped a database migration, rolling back the code does **not**
undo the migration — restore the database backup from before the update instead.
