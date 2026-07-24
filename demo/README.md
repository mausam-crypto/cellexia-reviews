# Cellexia Reviews — Demo preview

A fully static, fully offline preview of the storefront reviews widget. It loads the **real
theme-app-extension assets** and hydrates them from a local mock dataset — no Shopify store, no
backend, no network requests of any kind.

## What loads what

| File | Role |
| --- | --- |
| `demo/index.html` | Product-page stand-in. Contains the inline `#cx-i18n` dictionary (English strings from `extensions/cellexia-reviews/locales/en.default.json`, flattened exactly as `snippets/cx-i18n.liquid` does) and the widget root `<div id="cellexia-reviews" class="cx" … data-demo="true">` with the same data attributes the Liquid block renders. |
| `demo/mock-data.js` | Defines `window.CellexiaDemoData` — product stats, AI summary + 8 topic chips, 28 multilingual reviews (en/fr/de/es/ja/ar), media gallery, and canned translations. Shapes match the storefront JSON API exactly (see the DTOs in `app/types/cellexia.ts` and `app/routes/proxy.api.reviews.tsx`). |
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
real storefront — and on any dialog, sheet or lightbox that is open at that moment, so you can
switch skins live mid-interaction (on the storefront, surfaces opened by the widget copy the
root's current skin automatically). The switch is CSS-only: the `.cx[data-cx-skin="cellexia"]`
and `.cx[data-cx-skin="luxe"]` override sections at the end of `cellexia-reviews.css` do all the
theming — no content, strings or behavior change.

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

## What is interactive

Everything the real widget does, resolved locally:

- Star-distribution rows, topic chips, search, sort, and the full filter panel filter the mock list.
- **Helpful** increments locally (and persists per browser via `localStorage`); **Report** opens
  the reason dialog and resolves locally.
- **Translate** swaps in the canned translations with the "Translated from …" note.
- **Write a review** opens the real form; submission shows the success panel without sending
  anything anywhere.
- The banner's **Design** switcher flips the whole widget (including any open dialog) between the
  **Amazon like**, **Cellexia** and **Luxe** skins — see "Previewing the three design versions"
  above.

## Editing the mock data

Open `demo/mock-data.js` and edit `window.CellexiaDemoData`. Keep the shapes identical to the
storefront API contract (`app/types/cellexia.ts` `ListResponse`): `product`, `summary`, `reviews`, `media_gallery`, `page`,
`per_page`, `total`, `total_pages`, plus `translations["<reviewId>"]["<target>"]` for the offline
translate flow. Option keys (`ageRange`, `skinConcerns`, `timeUsing`, `resultsSeen`) must come
from the canonical lists in `app/types/cellexia.ts`.

## What this page is for

It is the visual fidelity target for the widget (Amazon-style reviews UI) and a safe sandbox for
demos: nothing here talks to Shopify, and nothing entered on the page is stored or sent anywhere.
