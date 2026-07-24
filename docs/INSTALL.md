# Installation guide

Audience: a Shopify developer installing Cellexia Reviews for the first time. No prior knowledge
of this repository is assumed. Expect roughly half a day end to end, most of it hosting setup.

What you are installing:

1. A **Remix backend** (this repo) that you host yourself (Render, Fly.io, or Railway —
   walkthroughs below; a production `Dockerfile` is included).
2. A **Shopify app** entry on your Partner account (created/linked by the Shopify CLI) with an
   **app proxy** so the storefront can call the backend.
3. A **theme app extension** (deployed to Shopify by the CLI): an **app embed** that mounts the
   widget on product pages automatically and adds star badges to product cards site-wide
   (works on every theme, one toggle), plus two **app blocks** for precise manual placement on
   themes that support them. The merchant enables either — or both — in the theme editor.

**Pre-flight — decide these five things before you start** (everything else follows mechanically):

1. **Hosting**: Render, Fly.io, or Railway (§5 has a walkthrough for each; any non-sleeping
   instance works).
2. **Database**: default SQLite on a small volume, or Postgres (§4; Postgres only matters if
   you might ever run more than one instance).
3. **Partner account**: whose Shopify Partner account owns the app entry (it needs access to
   the merchant store, plus a development store for testing).
4. **Store domain**: the exact `*.myshopify.com` domain you will install on.
5. **Anthropic API key**: optional at install time — AI summary, review translation, and the
   QA generator activate whenever the merchant adds it later in Settings.

If something fails at any step, §11 (Troubleshooting) maps every anticipated symptom to its fix
— check it before debugging from scratch.

---

## 1. Prerequisites

- **Node.js >= 20.10** (`node -v`) — Node 20 or 22 LTS recommended (an `.nvmrc` pinning 22 is included). Avoid Node 23.2.0 specifically: a hex-decoding regression in that release breaks the Vite build.
- **Shopify CLI** (latest): `npm install -g @shopify/cli`
- A **Shopify Partner account** (partners.shopify.com) with access to the merchant's store,
  plus a development store for testing
- A **hosting account**: Render, Fly.io, or Railway (pick one)
- **Git** and a Git host (GitHub/GitLab) — Render and Railway deploy from a Git repo
- Optional but recommended: an **Anthropic API key** for AI summaries and translations
  (the merchant can also add it later in the app's Settings page)

---

## 2. Local setup and app creation

```bash
cd cellexia-review-app-ok-ok   # repo root
npm install
cp .env.example .env
cp shopify.app.example.toml shopify.app.toml
```

Link the config to an app on your Partner account (this fills in `client_id`; choose
"Create this app" when prompted and name it, e.g. "Cellexia Reviews"):

```bash
npm run config:link
```

> **Verify after linking**: open `shopify.app.toml` and confirm the `[app_proxy]` and
> `[webhooks]` sections from `shopify.app.example.toml` survived — the CLI sometimes rewrites
> the file without them when it creates a brand-new app. If they're missing, copy them back in
> from the example file now (they're required; §6 only replaces their placeholder URLs).

If the repo does not yet contain a `prisma/migrations/` directory, create the initial migration
once (this also creates a local SQLite database and generates the Prisma client):

```bash
npx prisma migrate dev --name init
```

Commit the generated `prisma/migrations/` folder — production deploys apply it via
`npm run setup` (`prisma generate && prisma migrate deploy`). If `prisma/migrations/` already exists, run
`npm run setup` instead.

Now verify the app runs locally against a development store:

```bash
npm run dev
```

The CLI opens a tunnel, serves the extension, and prints a preview link. Install the app on your
development store from that link and check that the embedded admin (Dashboard, Reviews,
Bulk add, Import / Export, QA data, Settings) loads.

Optional — seed ~15 demo reviews into a product to have something to look at:

```bash
npm run seed:demo -- --shop=<your-store>.myshopify.com --product=<numeric-product-id>
```

Optional — an offline visual preview of the storefront widget (no Shopify at all): open
`demo/index.html` in a browser. See `demo/README.md`.

---

## 3. Environment variables

| Variable | Required | Value / notes |
| --- | --- | --- |
| `SHOPIFY_API_KEY` | Yes | The app's Client ID. Partner Dashboard → Apps → your app → *Client credentials* (it is also written into `shopify.app.toml` as `client_id` by `npm run config:link`). |
| `SHOPIFY_API_SECRET` | Yes | The app's Client secret, from the same page. Also used to verify app-proxy HMAC signatures — the storefront API returns 401 without it. |
| `SHOPIFY_APP_URL` | Yes | Public HTTPS URL of the deployed backend, e.g. `https://cellexia-reviews.fly.dev`. No trailing slash. |
| `SCOPES` | Yes | `read_orders,read_products,write_products,read_files,write_files` |
| `DATABASE_URL` | Only if you change the datasource (see §4) | e.g. `file:/data/production.sqlite` or a Postgres connection string. |
| `CELLEXIA_ALLOW_UNSIGNED` | Never in production | `1` disables app-proxy signature verification. Local development/demo only. |
| `CELLEXIA_CLIENT_IP_HEADER` | Optional | Name of a platform-guaranteed client-IP header used for rate-limit buckets, e.g. `fly-client-ip` (Fly.io), `true-client-ip` (Render), `cf-connecting-ip` (Cloudflare). Leave unset unless your platform sets one — trusting an arbitrary header would let clients spoof their IP. |

`.env.example` lists the same variables with comments. Hosting platforms inject `PORT`
automatically; the server (`remix-serve`) honors it.

> **Protected customer data:** the `read_orders` scope powers verified-purchase detection. In the
> Partner Dashboard, open your app → API access and request access to protected customer data
> (orders; email field) — without it, order lookups on non-development stores are rejected by
> Shopify and reviews simply won't be marked verified.

---

## 4. Database: SQLite (default) or Postgres

The default is SQLite, exactly like the official Shopify template — `prisma/schema.prisma`
ships with:

```prisma
datasource db {
  provider = "sqlite"
  url      = "file:dev.sqlite"
}
```

That path is inside the container, and container filesystems are wiped on every deploy, so for
production do one of the following:

**Option A — SQLite on a persistent volume** (simplest; fine for one instance):

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

Mount a volume at `/data` (each walkthrough below shows how) and set
`DATABASE_URL=file:/data/production.sqlite`. Run a **single instance** — SQLite and the
in-memory rate limiter both assume one process.

**Option B — Postgres** (recommended if you may scale beyond one instance):

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Set `DATABASE_URL` to the connection string from your host's Postgres add-on. After changing the
provider, regenerate the migration history once against the new database:
`npx prisma migrate dev --name init-postgres` (run locally with `DATABASE_URL` pointing at it),
and commit the result.

Migrations are applied automatically on every container start: the Dockerfile runs
`npm run docker-start` = `prisma generate && prisma migrate deploy && remix-serve ...`.

---

## 5. Deploy the backend

The repo ships a production `Dockerfile` (node:20-alpine). All three walkthroughs use it.
Do one of A, B, or C.

### 5A. Render

1. Push the repo to GitHub/GitLab.
2. In the Render dashboard: **New → Web Service**, connect the repo.
3. Render detects the `Dockerfile`; leave the runtime as **Docker**. Pick an instance type that
   does not sleep (the free tier sleeps and, for SQLite, offers no persistent disk).
4. SQLite only — **Advanced → Add Disk**: name `cellexia-data`, mount path `/data`, 1 GB.
   (Postgres instead: **New → Postgres**, then copy its *Internal Database URL*.)
5. **Environment**: add every variable from the table in §3 (use the disk/Postgres value for
   `DATABASE_URL`). You can set `SHOPIFY_APP_URL` after the first deploy when you know the URL.
6. **Create Web Service**. When the deploy finishes, note the URL, e.g.
   `https://cellexia-reviews.onrender.com`, and set `SHOPIFY_APP_URL` to it (Render redeploys).

### 5B. Fly.io

```bash
# install flyctl: https://fly.io/docs/flyctl/install/  then:
fly auth login
fly launch --no-deploy        # run in the repo root; detects the Dockerfile.
                              # Pick an app name + region; decline extras you don't want.
```

Edit the generated `fly.toml`: under `[http_service]` set `internal_port = 3000`, and add:

```toml
[env]
  PORT = "3000"

# SQLite only:
[mounts]
  source = "cellexia_data"
  destination = "/data"
```

Then:

```bash
# SQLite only:
fly volumes create cellexia_data --size 1 --region <your-region>

fly secrets set \
  SHOPIFY_API_KEY=<client id> \
  SHOPIFY_API_SECRET=<client secret> \
  SHOPIFY_APP_URL=https://<app-name>.fly.dev \
  SCOPES=read_orders,read_products,write_products,read_files,write_files \
  DATABASE_URL=file:/data/production.sqlite

fly deploy
fly scale count 1             # SQLite + in-memory rate limiter: keep exactly one machine
```

Backend URL: `https://<app-name>.fly.dev`.

### 5C. Railway

1. Push the repo to GitHub.
2. railway.com → **New Project → Deploy from GitHub repo** → select the repo. Railway detects
   the `Dockerfile` and builds with it.
3. Open the service → **Variables**: add every variable from §3.
4. SQLite only — service **Settings → Volumes → Add Volume**, mount path `/data`.
   (Postgres instead: **Create → Database → PostgreSQL** in the same project, then set
   `DATABASE_URL` to the reference `${{Postgres.DATABASE_URL}}`.)
5. Service **Settings → Networking → Generate Domain** → you get
   `https://<name>.up.railway.app`. Set `SHOPIFY_APP_URL` to it.

---

## 6. Point Shopify at the deployed backend

Edit `shopify.app.toml` (the file you copied from `shopify.app.example.toml`; `client_id` was
filled by `npm run config:link`). Replace every placeholder URL with your real backend URL:

```toml
application_url = "https://YOUR-APP-URL"

[auth]
redirect_urls = [
  "https://YOUR-APP-URL/auth/callback",
  "https://YOUR-APP-URL/auth/shopify/callback",
  "https://YOUR-APP-URL/api/auth/callback"
]

[access_scopes]
scopes = "read_orders,read_products,write_products,read_files,write_files"

[app_proxy]
url = "https://YOUR-APP-URL/proxy"
prefix = "apps"
subpath = "cellexia"
```

The `[app_proxy]` block is what makes the storefront widget work: a shopper's browser requests
`https://<shop-domain>/apps/cellexia/api/reviews`, Shopify signs the request and forwards it to
`https://YOUR-APP-URL/proxy/api/reviews`. If the proxy is misconfigured, live data, submission,
votes and translation all fail (on a live store the widget's SSR part still renders — it comes
from metafields).

Push the configuration **and** the theme extension to Shopify:

```bash
npm run deploy
```

Confirm the release when prompted. Re-run `npm run deploy` any time you change
`shopify.app.toml` or anything under `extensions/`.

---

## 7. Install the app on the store

1. Partner Dashboard → Apps → your app → **Distribution** → choose **Custom distribution** and
   enter the merchant's store domain (this app is a single-store custom app).
2. Open the generated install link as the store owner and click **Install**.
3. Approve the requested scopes: `read_orders`, `read_products`, `write_products`,
   `read_files`, `write_files`.
4. The embedded admin opens. On first load the app registers its webhooks, creates the
   `cellexia` product metafield definitions and syncs the store's settings to shop metafields
   automatically.

A fresh install starts **Not live**: nothing whatsoever appears on the storefront — no widget,
no data, no structured data — until you complete §9. You can therefore do §8 and all testing
without store visitors noticing anything.

---

## 8. Put the widget on the storefront — app embed or blocks

There are two ways to get the widget onto the theme, both part of the same theme app
extension: no theme code is edited either way, and everything disappears cleanly if the app is
uninstalled.

- **Option A — the app embed**: one toggle, works on **every** theme, mounts the widget on
  product pages automatically and adds star badges to product cards site-wide.
- **Option B — the app blocks**: drag-and-drop placement, for themes that support app blocks
  on product templates.

If both end up active on the same product page, nothing renders twice: the block wins and the
embed's product-page widget steps aside automatically. (Keeping the embed enabled alongside
blocks is in fact useful — the site-wide card badges only come from the embed.)

> **Theme won't take the block? Use Option A.** On some themes, opening the product template
> and clicking **Add section → Apps** shows no Cellexia blocks at all. That means the theme
> does not support app blocks on product templates — nothing is wrong with your deploy. The
> app embed exists precisely for this case; it works on every theme.

### Option A — App embed (works on every theme, one click)

1. Shopify admin → **Online Store → Themes → Customize** (on the live theme).
2. In the theme editor's left sidebar, open **Theme settings** and select **App embeds**
   (in some theme-editor versions this is the puzzle-piece **App embeds** icon on the
   sidebar's edge).
3. Find **Cellexia Reviews** in the list and switch its toggle **on**.
4. Click **Save**.

That's it. The embed now mounts the full review widget on every product page automatically —
right after the product-information / add-to-cart area — and adds star badges next to product
names on the home page, collections and search results (only for products that have published
reviews). Then continue with §9 exactly as written: the embed follows the same not-live rules
as the blocks, so real visitors still see nothing until you go live.

Expand the embed's row (▸) to adjust its settings:

| Setting | Default |
| --- | --- |
| Show the review widget on product pages | On |
| Widget placement (CSS selector, optional) | empty — automatic placement |
| Show stars under the product title | On |
| Show star badges on product cards site-wide | On |
| Badge style | Stars and review count |
| Card title element (CSS selector, optional) | empty — automatic detection |

Setting-by-setting detail (including when to use the two CSS-selector overrides):
`docs/CONFIGURATION.md`, "App embed & star badges".

### Option B — App blocks (themes that support them)

Use the blocks when the theme accepts them and you want to place the widget by hand — per
template, exactly where you drag it.

**Main widget — "Cellexia Reviews"** (product pages):

1. Shopify admin → **Online Store → Themes → Customize** (on the live theme).
2. In the top-bar template picker choose **Products → Default product** (repeat for any other
   product templates the store uses).
3. In the left sidebar, under the template's section list, click **Add section**, open the
   **Apps** tab, and pick **Cellexia Reviews**.
4. Drag it to where reviews should appear (typically below the product description).
5. Select the block to adjust its settings: heading, AI summary on/off, photo strip on/off,
   review form on/off, reviews per page (5–30), star accent color.
6. Click **Save**.

**Star badge — "Cellexia Star Badge"** (under the product title):

1. Still in the product template, select the **Product information** section.
2. Click **Add block** inside it, open the **Apps** tab, pick **Cellexia Star Badge**.
3. Drag it directly under the product title block. Click **Save**.

The badge renders nothing until the product has at least one published review, so an empty
placement is normal at first.

Note that the **theme editor always shows the full widget**, whether or not the store is live —
that is intentional, so you can place and configure the widget here before anyone can see it.
On the real storefront, block and embed alike stay invisible until you go live (next section).

---

## 9. Preview, then go live

Adding the blocks changed nothing for visitors yet: the store is still **Not live**, and while
not live the widget is completely absent from the real storefront — hidden empty markup, no API
data (the backend answers 403), no JSON-LD. Previewing and going live happen in the app's
Dashboard:

1. Shopify admin → **Apps → Cellexia Reviews** → **Dashboard**. The banner at the top reads
   "Not live yet — store visitors can't see the review widget."
2. Click **Preview on your store**. A product page on the live theme opens in a new tab with
   the widget fully working and a "Preview mode" ribbon fixed at the bottom. Only your browser
   sees this — the link carries a private token — so check the placement and settings
   from §8 (block or embed) exactly as shoppers will get them. **Exit preview** on the ribbon ends it. (The
   button is disabled with an explanation while the store has no products.)
3. Back on the Dashboard, click **Go live** and confirm
   ("Make Cellexia Reviews visible to all store visitors?"). The banner switches to
   "Live — visitors can see the review widget." and the setup guide's step 4 completes.

You can hide the widget again at any time from the same banner ("Switch off" — all data is
kept), the preview link keeps working while live, and shared preview links can be invalidated
with **Settings → Data → Regenerate preview link**. Merchant-facing detail:
`docs/CONFIGURATION.md`, "Going live & previewing".

---

## 10. Final verification checklist

Work through every line; each has an unambiguous pass signal.

- [ ] **Backend up**: `https://YOUR-APP-URL` responds (the root route shows a minimal login
      form / redirects — anything but a connection error).
- [ ] **Embedded admin loads**: Shopify admin → Apps → Cellexia Reviews shows the Dashboard
      with the 4-step setup guide and the "Not live yet" banner.
- [ ] **App proxy reachable**: open
      `https://<shop-domain>/apps/cellexia/api/reviews?product_id=<numeric-product-id>`
      in a browser — while the store is still not live, the pass signal is a small JSON error
      (`{"ok":false,"errors":{"_":"not_live"}}`, HTTP 403): it proves Shopify forwards signed
      requests to your backend. A Shopify 404 page or a 401 means the proxy or the API secret
      is misconfigured. (Get the numeric id from the product's admin URL; after going live
      below, the same URL returns full JSON: `{"product": ..., "reviews": [...]}`.)
- [ ] **Not-live storefront is clean**: open the product page as a normal visitor (no preview
      link, or after "Exit preview") — no review widget, no star badge, no card badges,
      nothing visible.
- [ ] **Preview works**: Dashboard → **Preview on your store** — the widget (block or embed)
      renders fully on the live theme with the "Preview mode" ribbon at the bottom;
      **Exit preview** hides it again.
- [ ] **Go live**: Dashboard → **Go live** → confirm. The banner switches to "Live — visitors
      can see the review widget."
- [ ] **Widget renders**: the product page now shows the "Customer reviews" widget (block or
      embed) for everyone (no preview link needed).
- [ ] **Card badges render** (only with the app embed enabled and its badges setting on):
      collection/home product cards show star badges for reviewed products; cards of products
      without published reviews stay clean.
- [ ] **Submission works**: submit a test review from the storefront form — the success panel
      appears, and the review shows up in the admin under Reviews with status **Pending**
      (unless auto-publish is on).
- [ ] **Moderation works**: approve the test review — it appears on the storefront after a
      reload, and the rating header/star badge update (metafields are re-synced on approval).
- [ ] **Verified purchase**: a review submitted with the email of a real order for that product
      shows the orange **Verified Purchase** badge.
- [ ] **AI summary** (if a key is configured in Settings → AI summary): after ~5 published
      reviews, "Customers say" and topic chips render; or press "Regenerate AI summary" on the
      Dashboard's product table.
- [ ] **QA data round-trip** (optional; needs the same Anthropic key): **QA data** page →
      pick a test product, generate a small synthetic batch (say 10 reviews, status
      Published) — they render in the widget like real reviews, and the Dashboard shows the
      synthetic-data warning banner. Then **Delete batch** on the same page — the reviews
      disappear, the banner clears, and the product's rating returns to its previous state.
      Do this before going live: synthetic reviews are never labeled on the storefront.
- [ ] **Translations**: switch the storefront to another published language — the widget UI is
      translated; reviews in other languages show a "Translate" link (if a translation provider
      is configured).
- [ ] **Locales valid**: `npm run check:locales` exits 0.
- [ ] **Rich snippets** (only after going live — JSON-LD is not emitted while not live): run
      the product URL through Google's Rich Results Test (search.google.com/test/rich-results)
      — a *Product snippets* result with review/rating data is detected. See `docs/SEO.md`,
      including the note about themes that emit their own Product JSON-LD.
- [ ] **Cleanup**: delete the test review (Reviews → select → Delete) if it shouldn't stay.

Handing the store over to the merchant next? Point them at `docs/CONFIGURATION.md`, and read
`docs/UPDATE.md` yourself before applying any future release ZIP.

---

## 11. Troubleshooting — symptoms → fix

Every failure we can anticipate on a fresh install, with its exact cause. Find your symptom;
apply the fix; re-run the relevant §10 checklist line.

### Setup & deploy

| Symptom | Cause → fix |
| --- | --- |
| `npm install` fails on engine warnings, or `npm run build` dies with a `[vite:css-post] css content … was not found` error | Wrong Node version. Use Node 20 or 22 LTS (`nvm use` reads the included `.nvmrc`). Node 23.2.0 specifically is broken — any other 23.3+ works but LTS is safer. |
| `npm ci` fails with `EUSAGE … requires package-lock.json` inside Docker | You deleted or regenerated the repo without `package-lock.json`. Restore it from the ZIP — the Dockerfile depends on it. |
| `npm run dev` asks to create an app, then errors on organization selection | Your Partner account has no development store or you picked the wrong org. Create a development store first (Partner Dashboard → Stores). |
| `prisma migrate deploy` says "No migration found" | You are not running it from the repo root, or `prisma/migrations/` was not copied. The ZIP contains 4 migration folders — verify they exist before deploying. |
| Container boots then exits immediately; logs show a Prisma connection error | `DATABASE_URL` points at a path/DB that doesn't exist in the container. SQLite: the volume isn't mounted at `/data` (§5), or you forgot `DATABASE_URL=file:/data/production.sqlite` after switching the datasource to `env("DATABASE_URL")`. |
| Deploy works but everything resets after each redeploy (reviews vanish) | SQLite is on the container's ephemeral disk, not a volume. §4 Option A — mount a persistent volume and point `DATABASE_URL` at it. |

### Shopify wiring

| Symptom | Cause → fix |
| --- | --- |
| Embedded admin shows a blank page or an endless redirect loop | `SHOPIFY_APP_URL` doesn't exactly match the deployed URL (protocol/trailing slash matter), or the `[auth] redirect_urls` in `shopify.app.toml` still contain placeholders. Fix both, `npm run deploy`, reinstall the app. |
| Admin shows "App couldn't be loaded" right after install | The backend was asleep or unreachable during OAuth. Free-tier instances that sleep are unsuitable — use a non-sleeping instance (§5A note). |
| Proxy URL `https://<shop>/apps/cellexia/...` returns Shopify's own 404 page | The `[app_proxy]` block wasn't deployed (run `npm run deploy` and confirm the release) — or another app already owns the `/apps/cellexia` path prefix. Path collision: change `subpath` in `shopify.app.toml` to e.g. `cellexia-reviews`, **and** update the hardcoded path in two extension files to match — `data-proxy="/apps/cellexia/api"` in `extensions/cellexia-reviews/blocks/reviews.liquid` and the same fallback string in `extensions/cellexia-reviews/assets/cellexia-reviews.js` — then `npm run deploy`. |
| Proxy URL returns `{"ok":false,"errors":{"_":"unauthorized"}}` (401) | `SHOPIFY_API_SECRET` on the host doesn't match the app's current Client secret (rotated?). Update the env var and restart. |
| Proxy URL returns `{"ok":false,"errors":{"_":"not_live"}}` (403) | Not an error — the store isn't live yet (§9). This is the expected pass signal pre-go-live. |
| Blocks don't appear under the theme editor's **Apps** tab | The extension wasn't deployed (`npm run deploy`, confirm the release), or the app isn't installed on this store yet (§7 before §8). |
| **Can't add the block on the product page** — the extension is deployed, other pages offer the blocks, but **Add section → Apps** on the product template shows no Cellexia blocks | The theme doesn't support app blocks on product templates. Not fixable from our side and nothing is misconfigured — use §8 **Option A**: the app embed (Theme settings → App embeds → toggle **Cellexia Reviews**) mounts the widget on every theme. |
| Reviews never get the Verified Purchase badge | Protected customer data access for orders hasn't been approved (§3 note). Development stores don't need it; live stores do. |

### The most common one

| Symptom | Cause → fix |
| --- | --- |
| **"We added the block but nothing shows on the product page."** | Working as designed: a fresh install is **Not live** and the widget is invisible to visitors until you click **Go live** (§9). Use **Preview on your store** to see it privately first. In the *theme editor* the widget always renders so you can position it. |

### Features

| Symptom | Cause → fix |
| --- | --- |
| "Customers say" / topic chips never appear | No Anthropic API key in Settings → AI summary, or fewer than the threshold (default 5) published reviews. Use the Dashboard's "Regenerate AI summary" button to force one. |
| Translate links missing on foreign-language reviews | Translation provider is Off, no key for the chosen provider, or "Show “Translate” buttons on the storefront" unchecked (Settings → Translation). |
| QA generator fails immediately | It requires the Anthropic key from Settings → AI summary — the error banner says exactly this. Add the key or skip the generator. |
| CSV import reports many date errors | Wrong date format assumption. Set the **Date format** select on the import page to match your file (ISO / DD/MM/YYYY / MM/DD/YYYY) and re-run the dry run. |
| Widget looks unstyled or oddly cramped in one theme section | Another app or the theme is injecting CSS into the section. The widget's CSS is fully scoped under `.cx` and never leaks out; move the block to its own section (§8) rather than nesting it inside a third-party section. |
| Star badge block renders nothing | Expected until the product has at least one published review (and the store is live). |
| Badges don't appear on product cards | In order of likelihood: the app embed isn't enabled, or its **Show star badges on product cards site-wide** setting is off (§8 Option A); the store isn't live yet — badges follow the same gating as the widget (§9); those products have no published reviews (badges only appear for reviewed products); or the theme's card markup is unusual — set **Card title element (CSS selector, optional)** on the embed to the theme's card-title selector (see `docs/CONFIGURATION.md`, "App embed & star badges"). |

Still stuck? Check the backend logs on your hosting dashboard first — storefront/proxy and
service failures log `[cellexia]`-prefixed lines, and admin-page failures log descriptive lines
ending in "failed"; search the logs for `[cellexia]` and `failed`.
