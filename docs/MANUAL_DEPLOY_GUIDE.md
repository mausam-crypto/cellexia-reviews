# Manual deploy guide — Cellexia Reviews

For when a new update ZIP arrives and no automated assistant is available to
run it through. Follow this in order.

## 0. Where everything lives

| Thing | Value |
|---|---|
| Canonical working copy | `cellexia-apps/cellexia-reviews/cellexia-reviews` |
| GitHub | `github.com/mausam-crypto/cellexia-reviews` (branch `master`) |
| Render service | `cellexia-reviews` → `cellexia-reviews.onrender.com` |
| Render database | `cellexia-reviews-db` (Postgres, free plan) |
| Shopify Partner org | Cellexia Ltd |
| Client ID | `95e2153e12b6549d39df5bc9699e9393` |
| App proxy subpath | `apps/cellexia-reviews/*` — **this app's default template ships `cellexia` as the subpath, which collides with the AOV & LTV Booster app.** Every update needs this checked (see §3). |
| Live store | This app is installed on `cellexia-labs.myshopify.com` (the real store) — the other apps in this family have mostly been dev-store-first; this one went live directly. Treat every change here as store-facing immediately. |

## 1. Before touching anything

```bash
cd cellexia-reviews/cellexia-reviews
git status --short             # must be empty
ls shopify.app*.toml           # should show shopify.app.toml AND shopify.app.example.toml
                                # — that's normal (the example file is the upstream template,
                                # not a stray duplicate). Only worry if you see a THIRD
                                # differently-named shopify.app.*.toml file.
```

## 2. Diff against the last real update, not this repo

Same reasoning as the other apps: this folder's Liquid/JS has already been
patched for the proxy-path collision, so a fresh export will show that as a
"regression" in the diff — that's expected, see §3. If you still have the
previous update ZIP, diff the new one against that instead of against this
canonical folder, to cut down on noise:

```bash
diff -rq /path/to/previous-update/cellexia-reviews \
         /path/to/new-update/cellexia-reviews \
  --exclude=node_modules --exclude=.git --exclude=build --exclude=dist \
  --exclude=.env --exclude=".shopify" --exclude="shopify.app.toml"
```

Read `CHANGELOG.md` and `docs/UPDATE.md` in the new ZIP fully first.

## 3. The proxy-path collision — check this on EVERY update

This app's own default template uses `/apps/cellexia/*` as its app-proxy
path. **That path is already owned by the Cellexia AOV & LTV Booster app on
this store.** If Reviews' proxy ever actually deploys with that subpath, its
API calls would either collide with or be silently routed to the wrong app.
The correct, already-configured value is `cellexia-reviews`.

Every update needs this checked — search the entire new export for the bad
pattern before merging anything:

```bash
grep -rn "apps/cellexia\b" extensions/ app/ | grep -v "cellexia-reviews"
```

Anywhere this matches (not just the obvious spots), replace `/apps/cellexia`
with `/apps/cellexia-reviews`. Known repeat offenders, checked release after
release:

- `shopify.app.toml`'s `[app_proxy] subpath` (never overwrite this file at
  all anyway — see §4 — but if you ever do touch it, this is why not to).
- `extensions/cellexia-reviews/blocks/reviews.liquid` and `blocks/embed.liquid`
  — both the `data-proxy` attribute and doc comments.
- `extensions/cellexia-reviews/assets/cellexia-reviews.js` — has (at least)
  two separate hardcoded fallback strings, not just one.
- Every `app/routes/proxy.*.tsx` file's JSDoc comment describing its own
  route path (cosmetic, but fix them anyway — they're what a future reader
  trusts).

As of v1.5.1 the app centralized this into one snippet,
`extensions/cellexia-reviews/snippets/cx-proxy.liquid` — if a future update
keeps that snippet and it already contains `cellexia-reviews`, most of this
section is moot; just confirm the snippet itself wasn't reverted.

## 4. Files that will look "changed" but are NOT — never copy these over

- **`app/routes/app._index.tsx`** — nearly every release has shipped this
  file with `<Button url={themeEditorUrl} external>` on the "Open theme
  editor" button. `external` doesn't work inside the embedded admin iframe —
  clicking it throws "admin.shopify.com refused to connect." The fix,
  already in this repo, is `target="_blank"` instead of `external`. Diff the
  file; if that's the only change, don't copy it over.
- **`app/shopify.server.ts`** — same three-part pattern as every app in this
  family (dotenv import, `RENDER_EXTERNAL_URL` fallback, `SingleMerchant`
  not `AppStore`). Keep this repo's version.
- **`package.json`** — keep `docker-start` → `setup:production` (Postgres
  `db push`), not the export's `setup` (SQLite-dialect `migrate deploy`,
  which fails against this app's Postgres database). Also keep the
  `dotenv` dependency — the export's `package.json` doesn't list it.
- **`extensions/cellexia-reviews/shopify.extension.toml`** — the export
  omits the `uid` line. Don't copy this file over; the `uid` is what keeps
  `shopify app deploy` updating the existing extension instead of risking a
  duplicate.

## 5. Sanity suite

```bash
npm install
npx prisma generate
npx tsc --noEmit
npm run build
node scripts/check-locales.mjs   # must exit 0 / print "Locale check passed"
npx shopify app build
```

## 6. Deploy

```bash
git add -A
git commit -m "describe what actually changed"
git push origin master           # Render auto-deploys the app server

ls shopify.app*.toml              # confirm no THIRD stray toml appeared
npx shopify app deploy --allow-updates
```

Confirm Render redeployed:

```bash
curl -s -o /dev/null -w "HTTP %{http_code}\n" https://cellexia-reviews.onrender.com/ --max-time 20
```

Should return `200`.

## 7. Safety

A fresh feature ships **Not Live** by design — nothing shows on the
storefront (no widget, no data, no JSON-LD) until someone clicks **Go live**
in the app's own Dashboard. Deploying a new version never flips that switch
by itself. Since this app is on the live store already, still double check
after any deploy that the storefront looks the same as before for a normal
(non-preview) visitor.
