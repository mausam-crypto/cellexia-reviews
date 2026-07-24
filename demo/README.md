# Cellexia Reviews — Demo preview

A fully static, fully offline preview of the storefront reviews widget. It loads the **real
theme-app-extension assets** and hydrates them from a local mock dataset — no Shopify store, no
backend, no network requests of any kind.

## What loads what

| File | Role |
| --- | --- |
| `demo/index.html` | Product-page stand-in. Contains the inline `#cx-i18n` dictionary (English strings from `extensions/cellexia-reviews/locales/en.default.json`, flattened exactly as `snippets/cx-i18n.liquid` does), the `#cx-embed-config` JSON the v1.5 app embed renders (here it switches on the site-wide badge injector), the widget root `<div id="cellexia-reviews" class="cx" … data-demo="true">` with the same data attributes the Liquid block renders, and a six-card **product card grid** under the widget for the v1.5 star badges. |
| `demo/mock-data.js` | Defines `window.CellexiaDemoData` — product stats, AI summary + 8 topic chips, 28 multilingual reviews (en/fr/de/es/ja/ar), media gallery, canned translations, and the v1.5 `badges` map (per-handle average + count) for the card grid. Shapes match the storefront JSON API exactly (see the DTOs in `app/types/cellexia.ts` and `app/routes/proxy.api.reviews.tsx`). |
| `../extensions/cellexia-reviews/assets/cellexia-reviews.css` | The real widget stylesheet (loaded via relative path). |
| `../extensions/cellexia-reviews/assets/cellexia-reviews.js` | The real widget script. Because the root carries `data-demo="true"`, it reads `window.CellexiaDemoData` instead of fetching `/apps/cellexia/api/*`. |

All review media are inline SVG data URIs (gradient placeholders, including one "video" with a
play glyph), so the page never touches the network.

## How to open it

Either way works:

- **Directly:** double-click `demo/index.html` (works from `file://`).
- **Static server:** from the repository root run

  ```sh
  python3 -m http.server
  ```

  then visit <http://localhost:8000/demo/>.

The only requirement is a full checkout: the page references the extension assets via relative
paths, so `extensions/cellexia-reviews/assets/` must exist next to `demo/`. If the assets are
missing, the page shows an explanatory notice instead of a blank screen.

## Previewing the three design versions (v1.1 & v1.3)

The dark banner at the top carries a **Design** switcher with three buttons:

- **Amazon like** (default) — the battle-tested v1.0 review layout and palette.
- **Cellexia** — identical layout, structure and behavior, restyled to match cellexialabs.com
  (ink & periwinkle palette, uppercase condensed headings, pill buttons and chips).
- **Luxe** (v1.3) — the same trusted layout with the warmth of a premium D2C skincare brand:
  warm porcelain neutrals, champagne-gold stars and bars, refined serif headings, soft filled
  chips and soft-rectangle buttons.

The buttons toggle `data-cx-skin="amazon" | "cellexia" | "luxe"` on the widget root — the exact
attribute `blocks/reviews.liquid` renders from the `cellexia.design_theme` shop metafield on a
real storefront — on any dialog, sheet or lightbox that is open at that moment, and on the
star badges injected into the card grid (v1.5), so you can switch skins live mid-interaction
(on the storefront, surfaces opened by the widget copy the root's current skin automatically).
The switch is CSS-only: the `.cx[data-cx-skin="cellexia"]` and `.cx[data-cx-skin="luxe"]`
override sections at the end of `cellexia-reviews.css` do all the theming — no content, strings
or behavior change.

## The product card grid (v1.5 site-wide star badges)

Below the widget, a "More from Cellexia" grid of six fake product cards mimics a theme's
collection/home/search cards: each card is a `/products/<handle>` link plus a heading that
contains the link — the exact markup the app embed's badge injector scans for on a real
storefront. The page also carries the `#cx-embed-config` JSON that `blocks/embed.liquid`
renders when the app embed is enabled (with `enable_badges` on), so the injector runs here
exactly as it would live — except that in demo mode it reads `CellexiaDemoData.badges`
instead of calling `GET /apps/cellexia/api/badges`.

What you should see:

- **Four cards get a star badge** after their product name — Régénérant Cellular Renewal
  Cream (4.6, 50,506), Éclat Vitamin C Serum (4.8, 1,234), Hydra-Riche Night Balm (4.2, 87)
  and Lumière Eye Contour Gel (3.4, 412) — in the "stars and review count" badge style.
- **Two cards stay clean**: Pureté Gentle Cleansing Foam (tagged "New — no reviews yet") and
  Velours Solaire SPF 50 are absent from the mock `badges` map, mirroring the real endpoint,
  which omits products without published reviews — their cards are left exactly as the theme
  made them.
- The **Design** switcher in the banner restyles the badges together with the widget
  (Amazon-orange, Cellexia-ink or Luxe-gold stars).

The card links are inert on this page (the products only exist here); their hrefs are still
real product-URL paths because that is how the injector derives each card's handle.

## What the demo dataset contains

- Product: **Cellexia Régénérant Cellular Renewal Cream** — 4.6 average, 50,506 global ratings,
  star distribution 81 / 10 / 5 / 1 / 3 %.
- "Customers say" AI summary with 8 topic chips matching the Amazon reference set:
  Moisturizing (2,800), Texture (937 — 835 positive / 102 negative), Skin compatibility (789),
  Lightweight (570), Non-greasy (555), Value for money (492), Fragrance-free (428) and
  Pore clogging (510, negative). Each topic carries `terms` for `<mark>` highlighting and
  `reviewIds` for topic filtering.
- 28 realistic skincare reviews across en / fr / de / es / ja / ar, with structured attributes
  (age range, skin concerns, time using, results seen), verified-purchase flags, helpful counts,
  brand replies (including one in German), and photo/video media on several reviews.
- Canned English translations for every non-English review, so **Translate** and
  **Translate all reviews** work offline.
- A `badges` map (product handle → `{ average, count }`) for four of the six card-grid
  products — the inner `badges` object of the `GET /apps/cellexia/api/badges` response.

## What is interactive

Everything the real widget does, resolved locally:

- Star-distribution rows, topic chips, search, sort, and the full filter panel filter the mock list.
- **Helpful** increments locally (and persists per browser via `localStorage`); **Report** opens
  the reason dialog and resolves locally.
- **Translate** swaps in the canned translations with the "Translated from …" note.
- **Write a review** opens the real form; submission shows the success panel without sending
  anything anywhere.
- The banner's **Design** switcher flips the whole widget (including any open dialog, and the
  card-grid star badges) between the **Amazon like**, **Cellexia** and **Luxe** skins — see
  "Previewing the three design versions" above.
- The card grid's **star badges** inject themselves from the mock badges payload — see
  "The product card grid" above.

## Editing the mock data

Open `demo/mock-data.js` and edit `window.CellexiaDemoData`. Keep the shapes identical to the
storefront API contract (`app/types/cellexia.ts` `ListResponse`): `product`, `summary`, `reviews`, `media_gallery`, `page`,
`per_page`, `total`, `total_pages`, plus `translations["<reviewId>"]["<target>"]` for the offline
translate flow and `badges["<handle>"] = { average, count }` for the card grid (add the same
handle to a card in `index.html` to see it badged; leave a handle out to see its card stay
clean). Option keys (`ageRange`, `skinConcerns`, `timeUsing`, `resultsSeen`) must come
from the canonical lists in `app/types/cellexia.ts`.

## What this page is for

It is the visual fidelity target for the widget (Amazon-style reviews UI) and a safe sandbox for
demos: nothing here talks to Shopify, and nothing entered on the page is stored or sent anywhere.
