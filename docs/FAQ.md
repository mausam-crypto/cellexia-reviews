# Frequently asked questions

Audience: the merchant. Technical setup questions are covered in `docs/INSTALL.md`; settings
are explained in `docs/CONFIGURATION.md`.

## Theme & storefront

**Will this break my theme or my store?**
No — and installing it changes nothing visible either. The widget and the star badge are
**app blocks**: you add, move and remove them in the theme editor, and not a single line of
your theme's code is modified. All widget styles are scoped under the widget's own container,
so they cannot leak into or restyle the rest of your theme, and your theme's styles don't
bleed into the widget. On top of that, a new install starts **Not live**: even after you add
the blocks, store visitors see absolutely nothing — no widget, no data, no hidden Google
markup — until you press **Go live** on the app's Dashboard. You can install, place the
blocks, import your old reviews and preview the result on your real theme with zero risk of
shoppers seeing a half-configured page. Removing the blocks — or uninstalling the app —
leaves the theme exactly as it was.

**Why don't visitors see the reviews yet?**
Almost always: the store isn't **live** yet. New installs start Not live, which hides the
widget and star badge from every visitor until you click **Go live** on the app's Dashboard —
the banner there tells you the current state. Two things are easy to mix up meanwhile:

- The **theme editor** always shows the full widget, even when not live — that's on purpose,
  so you can place and configure it.
- **Preview on your store** (Dashboard) shows you the widget on the real storefront with a
  "Preview mode" ribbon at the bottom of the page. If you see that ribbon, you're looking at
  your private preview — visitors still see nothing until you go live.

Once live, the remaining reasons are the usual ones: the block isn't added in the theme
editor, or the product has no published reviews yet. See `docs/CONFIGURATION.md` §2.

**Does it slow my pages down?**
It's built not to: the rating header and top reviews are rendered on the server so they paint
with the page, one small CSS file and one deferred JavaScript file load, live data is fetched
once and cached for 60 seconds, and images lazy-load. There is no layout jumping while it loads.

**Can I change the widget's colors or heading?**
The heading and the star accent color are block settings in the theme editor (select the
Cellexia Reviews block). Deeper wording changes are covered in `docs/TRANSLATIONS.md`.

**Why doesn't the star badge show under my product title?**
The badge follows the same **Go live** switch as the main widget (see above), and it renders
nothing until that product has at least one **published** review. Also check the badge block
was added to the product template (`docs/INSTALL.md` §8).

## Reviews & moderation

**Do reviews go live immediately?**
Only if you enable auto-publish (Settings → General). By default every review waits in
Pending for your approval. Either way, if 3 different shoppers report a published review it
automatically returns to Pending for a second look. (This per-review approval is separate
from the store-wide **Go live** switch — published reviews only appear to visitors once the
store itself is live; see "Why don't visitors see the reviews yet?" above.)

**What does "Verified Purchase" mean here?**
The reviewer was recognized as a real buyer: either they were logged into their customer
account when reviewing, or their email matches an order for that product. It's automatic —
you can't manually toggle it.

**Can shoppers edit or delete their review?**
No. If a customer asks for a change, delete the review in the admin and invite them to submit
a new one.

**Can I answer a review?**
Yes — that's the Reply field on the review's page. It appears publicly as "Response from
Cellexia". See `docs/CONFIGURATION.md` §6.

**How does the app fight fake/spam reviews?**
Several layers: a hidden trap field that bots fill in, a minimum time-to-fill check on the
form, per-visitor rate limits, your moderation queue, and shopper reports (3 reports send a
review back to moderation). Media files are also re-checked on the server for type and size.

**Are synthetic (QA) test reviews visible to shoppers?**
Yes — if they are published and the store is live, shoppers see them exactly like real
reviews. That is the point: the **QA data** page generates realistic reviews so you can check
the layout, filters, translations and design versions with believable content before real
reviews exist. They are labeled **only inside the admin** (a blue "Synthetic" badge, a Source
filter, batch tracking) — the storefront never marks them, and shoppers cannot tell them
apart. That's why the app watches this for you: the Dashboard shows a warning banner whenever
published synthetic reviews exist, and it turns **critical** the moment the store is live.
Delete every batch on the QA data page before going live to real customers — each batch has a
one-click delete, and ratings recalculate automatically. See `docs/CONFIGURATION.md` §9.

## Photos & videos

**What can shoppers attach?**
Up to 5 photos (JPEG, PNG, WebP, HEIC — max 8 MB each) and 1 video (MP4, MOV, WebM — max
80 MB) per review. Files are stored in your own Shopify Files area and served from Shopify's
CDN.

**I'm on a lower Shopify plan — do videos work?**
Photo uploads work on all plans. Video hosting depends on your Shopify plan's file/video
support; if your plan (e.g. Basic) doesn't accept a video upload, the review is still saved —
just without the video. Photos are unaffected.

## Languages

**Which languages does the widget speak?**
17, out of the box: English, French, German, Danish, Swedish, Finnish, Dutch, Italian,
Spanish, Arabic (with full right-to-left layout), Polish, Portuguese (Portugal), Japanese,
Norwegian, Romanian, Hungarian, Greek. The widget follows your storefront's published
languages automatically.

**And reviews written in another language?**
Shoppers get a "Translate" link per review (and "Translate all reviews") when a translation
provider is configured in Settings → Translation. Details in `docs/TRANSLATIONS.md`.

## AI features

**Do I need an AI key?**
No — the app is fully functional without one. Without an Anthropic API key the "Customers say"
summary and topic chips simply don't appear, and without any translation provider the
translate links don't appear. Add keys any time in Settings; sections start rendering once
there's data.

**Why is there no summary on a product?**
Either no Anthropic key is set, or the product hasn't reached enough published reviews yet
(the auto-generate threshold, default 5). You can always force it: Dashboard → product table →
"Regenerate AI summary".

**Is the AI content labeled?**
Yes — the storefront shows "AI-generated from the text of customer reviews." under the summary.

## Rate limits

**Are there limits on shopper actions?**
Yes, per visitor (by IP), to prevent abuse: 5 review submissions per hour, 60 helpful votes
per hour, 20 reports per hour, 120 translation requests per hour. Shoppers who hit a limit get
a polite error and can retry later. Normal customers never notice these.

## Data, privacy & uninstall

**Where does my review data live?**
In the app's own database on your hosting (see `docs/HANDOVER.md`). You can export everything
as CSV at any time: Settings → Data, or the Import / Export page. Reviewer emails are never
shown publicly and never included in what the storefront exposes.

**Is it GDPR-compliant?**
The app implements Shopify's mandatory privacy webhooks: when a customer asks your store for
their data or for erasure, Shopify notifies the app (`customers/data_request`,
`customers/redact`) and the app deletes that customer's reviews on a redaction request. When
you uninstall, Shopify's `shop/redact` webhook (sent about 48 hours later) triggers deletion
of all the store's app data.

**What happens if I uninstall?**
The blocks vanish from your theme automatically (nothing to clean up), stored sessions are
removed immediately, and all app data is deleted after Shopify sends the shop-redaction
webhook. If you might come back, export the CSV first — after redaction the data is gone.

**What if my question isn't here?**
Configuration and workflows: `docs/CONFIGURATION.md`. Wording and languages:
`docs/TRANSLATIONS.md`. Google stars: `docs/SEO.md`. Anything technical: send your developer
`docs/INSTALL.md` and `docs/HANDOVER.md`.
