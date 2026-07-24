# SEO guide: star rich snippets

How Cellexia Reviews earns review stars in Google search results, how to validate the setup,
and the one conflict to check for (duplicate Product JSON-LD).

## What you get

- **Star rich snippets**: Google can show a star rating, rating value and review count under
  your product pages in search results.
- **Indexable review content**: the rating header and the product's top reviews are rendered
  server-side in the page HTML — search engines see real review text, not an empty JavaScript
  placeholder.

## How it works in this app

1. Whenever a review is approved, rejected or removed, the app recomputes the product's
   aggregates and writes them to **product metafields** in the `cellexia` namespace:
   `rating`, `rating_count`, `distribution`, `top_reviews`, `summary`.
2. The theme app extension renders from those metafields **in Liquid, on the server**:
   - the visible rating header and top reviews (instant paint, no JavaScript required);
   - one `<script type="application/ld+json">` tag with structured data
     (from the extension's `cx-jsonld` snippet).
3. The JSON-LD describes one `Product` entity, deliberately namespaced with
   `"@id": "<store-url><product-url>#cellexia-product"`, containing:
   - `name`, `image`, `description`, `sku`, `brand`
   - `offers` (price and availability, straight from Liquid)
   - `aggregateRating` (`ratingValue`, `ratingCount` from the metafields)
   - `review`: up to 3 top reviews (author, date, rating, body)

Safeguards, so the markup is always valid or absent — never wrong:

- Nothing is emitted until the product has at least one published review
  (`rating_count > 0`).
- Nothing is emitted if the merchant turned JSON-LD off (app Settings → Display →
  "JSON-LD").
- All strings are escaped; numbers are validated.

There is nothing to configure for SEO — it is on by default and keeps itself in sync as
reviews change.

## Validating the setup

1. Pick a product that has at least one **published** review.
2. Open Google's **Rich Results Test**: `https://search.google.com/test/rich-results`, enter
   the product page URL (the public storefront URL, not the admin), and run the test.
3. Expected result: **Product snippets** detected, with review count and rating listed, and no
   errors. Warnings about optional fields you don't use are fine.
4. If nothing is detected: view the page source and search for `cellexia-product` — if the
   JSON-LD block is missing, the product either has no published reviews yet or JSON-LD is
   disabled in the app's Settings → Display.
5. Longer term, watch **Google Search Console**: the product-snippet report shows how many of
   your pages Google has accepted, plus any markup errors.

Two expectations to set with the merchant:

- **Time**: after the markup validates, stars typically take days to weeks to appear as Google
  recrawls pages.
- **Discretion**: valid markup is a prerequisite, not a guarantee — Google decides per page and
  per query whether to show stars.

## Important: themes that emit their own Product JSON-LD

Many themes (including Shopify's free themes) already output their own `Product` structured
data on product pages. With this app active you can end up with **two** Product JSON-LD blocks
on the same page.

This is usually tolerated — this app sets an explicit distinct `@id` so its entity is
distinguishable, and only the app's block carries `aggregateRating` and `review` data unless
your theme also has a review integration. But two Product entities describing the same product
can make Google pick unpredictably, and conflicting data (e.g. a theme block with a stale
rating from a previous review app) can cost you the stars.

Recommendation — exactly one source of review structured data:

- **Keep the app's JSON-LD** (recommended: it is the one with live review data) and, if your
  theme has a "structured data" or "SEO" toggle for products, turn the theme's off; or ask
  your developer to remove/limit the theme's product JSON-LD snippet.
- Or, if you must keep the theme's markup and it already includes rating data from another
  source, turn **JSON-LD off** in the app: Settings → Display. Never let two different
  aggregateRating values coexist.

If you migrated from another review app (Judge.me, Loox, Yotpo), double-check their theme
snippets/JSON-LD were removed on uninstall — leftovers are the most common source of
conflicting rating markup.

## Performance notes (also ranking-relevant)

- Meaningful first paint is server-rendered from metafields; JavaScript hydrates in place, so
  there is **no layout shift** from the widget.
- Exactly one CSS file and one deferred JS file; no external requests other than the review API
  (GET responses cached 60 s) and Shopify's media CDN; images lazy-load.
- Budgets enforced by design: CSS ≤ 30 KB, JS ≤ 60 KB unminified.
