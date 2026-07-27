# Frequently asked questions

Audience: the merchant. Technical setup questions are covered in `docs/INSTALL.md`; settings
are explained in `docs/CONFIGURATION.md`.

## Theme & storefront

**Will this break my theme or my store?**
No — and installing it changes nothing visible either. The widget and the star badge are
**app blocks** — and there is also an **app embed** you simply switch on in the theme editor
(Theme settings → App embeds) for themes that don't take blocks on product pages. Either way,
not a single line of your theme's code is modified. All widget styles are scoped under the
widget's own container, so they cannot leak into or restyle the rest of your theme, and your
theme's styles don't bleed into the widget. On top of that, a new install starts **Not live**:
even after you add the blocks or enable the embed, store visitors see absolutely nothing — no
widget, no data, no hidden Google markup — until you press **Go live** on the app's Dashboard.
You can install, place the blocks, import your old reviews and preview the result on your real
theme with zero risk of shoppers seeing a half-configured page. Removing the blocks, switching
the embed off — or uninstalling the app — leaves the theme exactly as it was.

**Why don't visitors see the reviews yet?**
Almost always: the store isn't **live** yet. New installs start Not live, which hides the
widget and star badge from every visitor until you click **Go live** on the app's Dashboard —
the banner there tells you the current state. Two things are easy to mix up meanwhile:

- The **theme editor** always shows the full widget, even when not live — that's on purpose,
  so you can place and configure it.
- **Preview on your store** (Dashboard) shows you the widget on the real storefront with a
  "Preview mode" ribbon at the bottom of the page. If you see that ribbon, you're looking at
  your private preview — visitors still see nothing until you go live.

Once live, the remaining reasons are the usual ones: neither the block is added nor the app
embed enabled in the theme editor, or the product has no published reviews yet. See
`docs/CONFIGURATION.md` §2.

**Why don't I see any stars yet?**
Because the app has no reviews of its own yet. Cellexia Reviews only ever shows the reviews
**it** holds — and a brand-new install holds none. The reviews you already collected in another
review app (Judge.me, Loox, Yotpo, or whatever you used before) are not visible to this app: they
live in that app's database, not in this one. Until reviews exist here, the stars under your
product title and the star badges on product cards are deliberately hidden — showing an empty
rating would be worse than showing nothing.

Three ways to get reviews into the app:

- **Import / Export** — bring your existing reviews over from a CSV export of your old app
  (Judge.me, Loox and Yotpo files are recognized automatically). See
  `docs/CONFIGURATION.md` §9.
- **Bulk add** — type in reviews you have on paper or in email, one product at a time
  (`docs/CONFIGURATION.md` §10).
- **QA data** — generate realistic test reviews to judge the layout before real ones arrive
  (`docs/CONFIGURATION.md` §11). Delete every batch before going live to real customers.

You never have to guess: the **Storefront connection** card at the top of the Dashboard has a
**Review data** check that states exactly how many published reviews the app holds, and warns
you when the answer is zero (`docs/CONFIGURATION.md` §1, "Storefront connection test"). Once
reviews are published — and the store is live — the stars appear by themselves.

**I see a message about previewing that I don't think shoppers should see. Is that a problem?**
No — those messages are built for you and only reach you. In the **theme editor** and in
**preview mode** the app tells you what's going on when it can't load data ("Preview session
expired", "Storefront connection not configured", a **Try again** button, or "No reviews yet —
import your reviews or generate test data in the app."). On the real storefront a shopper never
sees any of them: if something goes wrong there, the widget simply removes itself and your page
looks as if the app weren't installed. If a notice tells you the preview expired, reopen
**Preview on your store** from the Dashboard; for anything else, run the Dashboard's
**Storefront connection** test.

**Does it slow my pages down?**
It's built not to: the rating header and top reviews are rendered on the server so they paint
with the page, one small CSS file and one deferred JavaScript file load, live data is fetched
once and cached for 60 seconds, and images lazy-load. There is no layout jumping while it loads.

**Do the badges slow my store down?**
No. On any page, the badges make at most **one** small request — it covers every product card
on that page at once (up to 48 products) and the answer is cached for five minutes, so
repeated browsing doesn't re-ask. On pages without any product links, no request is made at
all. And while the store is not live, the badges do nothing whatsoever — no requests, no
processing. The stars themselves are tiny inline graphics that reuse the widget's already-
loaded files; nothing extra is downloaded.

**Can I change the widget's colors or heading?**
The heading and the star accent color are block settings in the theme editor (select the
Cellexia Reviews block). Deeper wording changes are covered in `docs/TRANSLATIONS.md`.

**Why doesn't the star badge show under my product title?**
The badge follows the same **Go live** switch as the main widget (see above), and it renders
nothing until that product has at least one **published** review. Also check that the badge
block was added to the product template — or, if you use the app embed instead, that its
"Show stars under the product title" setting is on (`docs/INSTALL.md` §8).

**Why don't my product cards show star badges on collections or the home page?**
First, make sure you are on version **1.8.0 or newer**. Versions 1.5.0 through 1.7.0 carried
a real bug that kept the card badges from ever appearing, however correct your setup was:
when Shopify builds a storefront page, it wraps the small piece of app code that carries the
app's internal address in invisible HTML comments — and those comments corrupted the address
the badge script calls, so its requests never reached the app. The main review widget masked
the same problem by quietly detecting the bad address and retrying (which cost every product
page one wasted request); the badge script had no such rescue, so badges failed everywhere.
Version 1.8.0 fixes both: the address is cleaned everywhere it is used, and the badge script
now recovers exactly like the widget. From there, the usual rules apply: card badges come
from the **app embed**, not from the blocks — enable it in the theme editor and keep
"Show star badges on product cards site-wide" on; the store must be **live**; and only
products with at least one **published** review get a badge (cards of unreviewed products
deliberately stay untouched). All the details: `docs/CONFIGURATION.md`, "App embed & star
badges" and §12.

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
Cellexia". See `docs/CONFIGURATION.md` §8.

**Can I choose which reviews shoppers see first?**
Yes — the **Display order** page (in the app's navigation). Pick a store-wide default from
six ranking systems (the Amazon-style helpfulness ranking is the default and is exactly how
the widget has always behaved), override the system per product, and hand-pick up to **10
featured reviews** per product that always lead the list in your exact order — there is even
a one-click **Feature on product page** action right on each review's page while you
moderate. Featured reviews apply under the default "Top reviews" sort; a shopper who
re-sorts, searches or filters sees their own choice — the app never overrides an explicit
filter. Changes reach the storefront within a minute. Details: `docs/CONFIGURATION.md` §6.

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
one-click delete, and ratings recalculate automatically. See `docs/CONFIGURATION.md` §11.

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
You choose how they appear, with the "Reviews written in other languages" setting in
Settings → Translation. By default they show in their original language and shoppers get a
"Translate" link per review (plus "Translate all reviews"). Or switch to automatic: reviews
then appear already translated into the shopper's language, marked "Translated from …" with a
"See original" link (and "See translation" to switch back). Both modes need a translation
provider configured in Settings → Translation — without one, reviews simply show in their
original language. Fair warning on the automatic mode: the first visitor to load reviews in a
language they haven't been translated into yet may wait a few seconds while the translations
are created; after that they are stored and instant for everyone. Details in
`docs/TRANSLATIONS.md` and `docs/CONFIGURATION.md` §3.

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

**How much does generating reviews cost?**
Whatever Anthropic charges you for the tokens used — **the app itself never bills anything**:
the QA generator (like every AI feature) runs on the Anthropic API key you added in
Settings → AI summary, so all usage lands on your own Anthropic account, at Anthropic's own
pay-per-use rates, with no markup and no app fee.

Before starting a run, press **Estimate cost** on the QA data page: it shows the expected
token counts, price in USD and duration for exactly the number of reviews you typed in
(`docs/CONFIGURATION.md` §11). The rates behind that estimate, per million tokens, follow the
model selected in Settings → AI summary:

- **claude-sonnet-5** — $3.00 input / $15.00 output. Anthropic's introductory pricing of
  $2.00 input / $10.00 output applies through August 31, 2026; the estimate uses the
  introductory rate while it lasts and says so.
- **claude-haiku-4-5** — $1.00 input / $5.00 output.

In practice this is inexpensive: a review costs a fraction of a cent to generate, so even a
run of several hundred reviews typically stays in the range of a dollar or two on
claude-sonnet-5 (less on claude-haiku-4-5). Estimates are approximate — the **actual** cost of
each job, computed from real token usage, is shown in the jobs table on the QA data page once
the job finishes.

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
