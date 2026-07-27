# Configuration guide

Audience: the merchant. Everything you can configure in Cellexia Reviews, and the day-to-day
workflows: moderating, replying, importing.

Open the app: Shopify admin → **Apps → Cellexia Reviews**. The app has seven pages, reachable
from its navigation menu: **Dashboard**, **Reviews**, **Display order**, **Bulk add**,
**Import / Export**, **QA data**, **Settings**.

---

## 1. Dashboard

- **Storefront connection** — the card at the very top: a one-click test that proves the
  connection between your storefront and the app actually works. See "Storefront connection
  test" below.
- **Status banner** — the very top of the Dashboard always shows whether the review widget is
  **Live** or **Not live** for store visitors, with the buttons to preview and to switch. This
  is where going live happens — see §2, "Going live & previewing".
- **Synthetic-data warning** — shown whenever published synthetic test reviews exist (§12,
  "QA data"). While the store is not live it is informational; once the store is live it turns
  **critical** ("… visible to real shoppers — delete them before customers see them."),
  because synthetic reviews look completely real to shoppers. It links straight to the QA data
  page, where batches are deleted.
- **Setup guide** — four steps shown until completed: add the review block in the theme
  editor, add your AI key, moderate your first reviews, preview then go live. Each step links
  to the right place.
- **Stat cards** — average rating, total reviews, pending count, published this month.
- **Needs attention** — reviews that are pending or have been reported by shoppers. Approve or
  reject them right from the list.
- **Products table** — per product: average, review count, last review date, and a
  **Regenerate AI summary** button with the time the summary was last generated. Use it after
  a wave of new reviews if you don't want to wait for the automatic refresh.

### Storefront connection test

A review widget depends on a chain of things: your theme has to load it, it has to be able to
reach the app, the app has to have reviews, and your theme has to have the up-to-date ratings.
The **Storefront connection** card tests that whole chain in one click — **Run test again** —
and tells you, in plain language, what to do about anything that isn't right. When everything is
in order the banner reads **"Storefront connection verified"**; if something is genuinely broken
the banner turns red. The card also shows when it last ran, and re-runs itself when you open the
Dashboard if it has never run or the last run is more than a day old.

Use it after installing, after any theme change, and before **Go live** — the go-live
confirmation shows the same summary and asks you to confirm a second time if a check is failing.

The seven checks, and what each one means for you:

| Check | What it proves | Typical fix when it isn't a pass |
| --- | --- | --- |
| **App proxy reachable** | Your storefront can actually reach the app, over the address Shopify forwards to it — and the app's secret key matched, so the connection is genuinely yours. The detail line shows the detected address. | A failure here is a developer task: the app's proxy settings weren't deployed, or another app is using the same address. Send your developer `docs/INSTALL.md` §6 and §11. Everything else on this list depends on this check. |
| **Preview token round-trip** | The private link behind **Preview on your store** works end to end — which is also what lets the **theme editor** show your real reviews. | **Settings → Data → Regenerate preview link**, then run the test again. |
| **Theme extension active** | A real storefront page has loaded the widget recently (within the last 7 days). | A warning here usually means the widget isn't on your theme yet: theme editor → **Theme settings → App embeds** → switch **Cellexia Reviews** on (§5), or add the block (§4). A brand-new install warns until the first storefront page loads — that is normal. |
| **Review data** | How many reviews the app itself holds (published, pending, and on how many products). | A warning at zero published is the single most common reason for "no stars anywhere": the storefront cannot show stars that don't exist yet. Import your existing reviews (§10), add them by hand (§11), or generate test data (§12). Reviews still held by a previous review app are **not** visible to this app until you import them. |
| **Metafield sync** | The ratings stored in your theme match the ratings in the app. This is what draws the stars under the product title, the star badges on product cards and the Google star data. | A warning offers **Re-sync all products** — press it, then re-run the test. |
| **Database persistence** | Your reviews are stored somewhere that survives an app update. | A warning here is for your developer only (`docs/INSTALL.md` §4): the hosting is set up in a way where reviews could be lost on the next deploy. Worth fixing before you collect real reviews. |
| **Live state** | Whether visitors can currently see the widget. | Informational — it's the same Live / Not live state as the banner below, with a link to go live (§2). |

Warnings are not failures: a store that is freshly installed, not yet live and has no reviews
will legitimately show warnings on *Theme extension active* and *Review data*. Failures (red)
mean the storefront genuinely cannot get data and should be fixed before going live.

**What shoppers see while something is wrong**: nothing. On a live store the widget removes
itself quietly rather than showing an error — no error box, no message, no broken layout. The
explanatory notices ("Preview session expired", "Storefront connection not configured", "Try
again") appear **only** for you, in the theme editor and in preview mode, and say so on
themselves.

---

## 2. Going live & previewing

Your storefront is always in one of two states:

- **Not live** — every new install starts here. Visitors see **nothing at all**: no widget, no
  star badge, no star badges on product cards, no review data, no Google structured data. You can take your time — add the
  blocks, adjust settings, import reviews — without shoppers noticing any change. (The **theme
  editor always shows the full widget**, live or not — with your real reviews in it — so you can
  place and configure the blocks.)
- **Live** — the widget is visible to every visitor.

**Where the buttons are**: the banner at the top of the **Dashboard**.

- Not live: "Not live yet — store visitors can't see the review widget." with
  **Preview on your store** and **Go live**.
- Live: "Live — visitors can see the review widget." with **Preview link** and **Switch off**.

**Previewing**: **Preview on your store** opens one of your product pages in a new tab with the
widget fully working on your real live theme. Only you see it — the link carries a private
token that your browser remembers, and a ribbon at the bottom of the page reads "Preview mode —
Only you can see this — the widget is not live for visitors." with an **Exit preview** button.
The preview works whether the store is live or not. If the button is disabled, the store has no
products to preview on yet.

**Before you go live**: if you generated synthetic test reviews (§12, "QA data"), delete every
batch first. Published synthetic reviews are indistinguishable from real ones on the
storefront — they are labeled only inside this admin — and the Dashboard banner turns critical
the moment you go live with any still published.

**Going live**: click **Go live** and confirm ("Make Cellexia Reviews visible to all store
visitors?"). The confirmation shows the summary of the storefront connection test (§1) so you
don't go live on a broken setup — if a check is failing you have to confirm explicitly a second
time ("Go live anyway"). That's it — a "You're live!" toast confirms, and the widget appears for everyone
within about a minute (the state is synced to a shop metafield, like the design version).
**Switch off** does the reverse, after its own confirmation ("Hide the review widget from all
store visitors? Your data is kept.") — reviews, settings, imports and replies are all
preserved, and you can go live again whenever you want.

**Regenerating the preview link**: shared a preview link with someone (an agency, a colleague)
and want to cut their access? **Settings → Data → Regenerate preview link**. Old links stop
working immediately; the Dashboard's preview button always uses the current link. A toast
confirms: "Preview link regenerated — old links no longer work." Anyone opening an old link now
gets a clear "Preview session expired" note telling them to reopen the preview from the app —
and shoppers, as always, see nothing at all.

**Status at a glance**: **Settings → General** shows a "Storefront status" badge (**Live** /
**Not live**) with a button to the Dashboard — the switching itself always happens on the
Dashboard banner.

**Upgrading from 1.0/1.1?** Nothing changes for you: the update automatically keeps existing
installations **live**, so your widget never disappears. Only brand-new installs start as
Not live.

---

## 3. Settings, card by card

Changes are saved with the Save button; a confirmation toast appears.

### General

| Setting | Default | What it does |
| --- | --- | --- |
| Storefront status | Not live (new installs) | Read-only row: a **Live** / **Not live** badge showing whether visitors can see the widget, with a button to the Dashboard — where the Preview, Go live and Switch off actions live. See §2, "Going live & previewing". |
| Brand display name | Cellexia | The name shown on your replies to reviews ("Response from Cellexia"). |
| Auto-publish new reviews | Off | On: new reviews go live immediately (you can still reject them later). Off: every review waits in **Pending** until you approve it. Keep it off unless volume makes moderation impractical. |
| Notification email | empty | Reserved for a future email-notification feature — the app does not send emails yet. Check the Dashboard's "Needs attention" list for new reviews. |

### AI summary

Powers the "Customers say" paragraph and the clickable topic chips on your product pages.

| Setting | Default | What it does |
| --- | --- | --- |
| Provider | Anthropic | Anthropic or Off. Off hides the summary section entirely. |
| Anthropic API key | empty | Paste your key here (see "Getting an Anthropic API key" below). Without a key, no summary is generated — the widget simply doesn't show that section. |
| Model | claude-sonnet-5 | claude-sonnet-5 (better quality) or claude-haiku-4-5 (cheaper/faster). |
| Auto-regenerate threshold | 5 | The summary refreshes automatically after this many new published reviews. |
| Regenerate all now | — | Button: rebuild the summary for every product immediately. |

**Getting an Anthropic API key**: go to **console.anthropic.com**, create an account, add a
payment method under Billing, then open **API Keys → Create Key**. Copy the key (it is shown
once) and paste it into this card. Usage is pay-per-use and for review summaries typically
amounts to a few cents per product per regeneration.

### Translation

Controls how reviews written in another language are shown to shoppers — the provider that
translates them, and the display mode that decides whether shoppers see the original or a
translation first.

| Setting | Default | What it does |
| --- | --- | --- |
| Provider | Anthropic | Anthropic / DeepL / Google / Off. Anthropic reuses the API key above. Off disables review translation entirely (no translate links, no automatic translation). |
| DeepL API key | empty | Only needed if provider is DeepL (get one at deepl.com, API plans). |
| Google API key | empty | Only needed if provider is Google (Google Cloud Translation API key). |
| Show “Translate” buttons on the storefront | On | The master switch for review translation on the storefront. Off disables it in both display modes below, without changing the provider. |
| Reviews written in other languages | Show in the original language, with a Translate button | The display mode for reviews whose language differs from the shopper's — the two choices are explained below. |

**The display mode.** The "Reviews written in other languages" choice decides what a shopper
sees when a review was written in a language other than the one they are browsing in:

- **"Show in the original language, with a Translate button (default)"** — the behavior the
  widget has always had, unchanged: the review appears exactly as written, and the shopper can
  translate it on demand (per review, or "Translate all reviews").
- **"Automatically translate into the shopper's language, with a 'See original' option"** —
  the review appears already translated, marked with a "Translated from French" (or whichever
  language) note and a **See original** link; the original view offers **See translation** to
  switch back. In this mode the per-review Translate button and the "Translate all reviews"
  link are hidden — they would be redundant.

Honest notes before you switch to automatic:

- It needs a working translation **provider and its API key** (the settings above). If the
  provider is off, the key is missing, or a translation call fails, nothing breaks and no error
  is shown: the affected reviews simply appear in their original language with the Translate
  button, exactly like the default mode.
- **The first page-load in a new language can take a few seconds.** Translations are created
  the first time a page of reviews is requested in a language they don't exist in yet. They are
  then stored, so every later visitor in that language gets them instantly — each review is
  translated at most once per language, so the translation cost is one-off, not per-visitor.
- This setting is about the **customer-written review content**. The widget's own interface
  (buttons, labels — including the "Translated from …" note and the See original / See
  translation links) is already translated into your 17 store languages — see
  `docs/TRANSLATIONS.md`.

### Design (design version)

Picks the **design version** of the review widget — the look of everything shoppers see on
your product pages. All three versions share exactly the same layout, structure, spacing and
behavior; only colors, typography and component finishes change.

| Setting | Default | What it does |
| --- | --- | --- |
| Design version | Amazon like | Switches the whole storefront widget between the three designs below. Applies storefront-wide — every product page at once. |

The three options:

- **Amazon like** (default) — the battle-tested review layout shoppers know from Amazon:
  orange stars and distribution bars, teal links, yellow Submit button. This is the original
  design and it never changes.
- **Cellexia** — the same trusted layout, restyled to match **cellexialabs.com**: near-black
  ink text, stars and buttons; pale periwinkle accents on the distribution bars, the Verified
  Purchase chip and brand replies; uppercase condensed headings in the brand's Gobold display
  font; fully-rounded pill buttons (white with an ink border — solid ink for Submit review);
  topic chips as outlined pills instead of teal links; underlined ink links. Clinical,
  monochrome, with generous white space — the brand's premium-medical feel.
- **Luxe — premium skincare** — the same trusted layout with the warmth of a premium skincare
  brand: warm porcelain neutrals on the soft surfaces (topic panel, brand replies, form
  pills), champagne-gold stars and distribution bars, refined serif headings in normal case
  over small uppercase micro-labels, and soft, gently-rounded rectangles instead of pills
  (white buttons with a hairline border — solid ink for Submit review); the Verified Purchase
  badge becomes a champagne chip, and links are ink with a fine gold underline. This is
  deliberately **not** the clinical monochrome of the Cellexia option — it feels like a luxury
  beauty brand's own component: warm, golden, quietly premium — while its neutrals still sit
  harmoniously next to cellexialabs.com.

Each option in the card shows a small preview row (star color, a button, the Verified Purchase
chip) so you can see the difference at a glance before saving.

**Where to switch it**: Shopify admin → **Apps → Cellexia Reviews → Settings**, the **Design**
card (the fourth card, between Translation and Display). Pick an option and Save.

**When it takes effect**: within about a minute of saving — the choice is synced to a shop
metafield (`cellexia.design_theme`) that the storefront widget reads. If a product page still
shows the old design after that, refresh it.

**A note on fonts**: the Cellexia design uses the brand's Gobold and argumentum fonts when your
theme already loads them (the live Cellexia store does), and the Luxe design's serif headings
use a premium display serif (Canela or Freight Display Pro) when the theme loads one. On themes
without those fonts, Cellexia falls back to similar condensed/system fonts and Luxe to a classic
serif (Playfair Display if the theme has it, otherwise Georgia) automatically — the app never
downloads font files.

### Display

| Setting | Default | What it does |
| --- | --- | --- |
| Reviews per page | 10 | How many reviews load per "See more reviews" click. (The theme-editor block setting of the same name overrides this per placement.) |
| Media strip | On | The "Reviews with images" thumbnail strip. |
| Summary section | On | The "Customers say" section (independent of the AI provider switch). |
| JSON-LD | On | The invisible structured data that makes Google show stars in search results. Only turn this off if your theme already outputs review structured data — see `docs/SEO.md`. |

### Data

- **Export reviews CSV** — takes you to the Import / Export page, where the export downloads
  all reviews (the template columns — see §10 —
  plus three tracking columns: `is_synthetic`, `source`, `synthetic_batch_id`). Do this
  periodically as a backup; the file re-imports cleanly via the Generic template preset.
- **Regenerate preview link** — creates a new private preview link and invalidates every
  previously shared one (see §2, "Going live & previewing"). A toast confirms: "Preview link
  regenerated — old links no longer work."
- **Delete all app data** — removes every review, vote, summary and setting for this store,
  after a confirmation dialog. This cannot be undone. Export a CSV first.

---

## 4. Widget settings in the theme editor

A few settings live on the block itself, because they are per-placement: Shopify admin →
**Online Store → Themes → Customize** → open the product template → select the
**Cellexia Reviews** block:

- **Heading** (default "Customer reviews") — translatable per language, see
  `docs/TRANSLATIONS.md`
- **Show AI summary and topics**, **Show customer photo strip**, **Allow writing reviews**
- **Reviews per page** (5–30)
- **Star color** (default the Amazon-style orange)

The **Cellexia Star Badge** block (stars under the product title) has its own small settings
and shows nothing until a product has published reviews.

There is also a third block, **Cellexia Overall Reviews** — the brand-wide review section for
the home page. It has its own section in this guide: §6, "Overall reviews widget".

The theme editor always shows the full widget while you work in it, even when the store is
**Not live** — placing and styling the blocks never requires going live first (§2).

If your theme refuses the blocks on the product template — or you want star badges on your
product cards everywhere — use the **app embed** instead: §5.

---

## 5. App embed & star badges

Some themes do not accept app blocks on product templates at all ("Add section → Apps" shows
no Cellexia blocks there). The **app embed** solves that — it works on **every** theme with a
single toggle — and it adds something the blocks don't have: **star badges next to product
names across your whole store** (home page, collections, search results, featured sections)
for products with published reviews.

**Turning it on**: Shopify admin → **Online Store → Themes → Customize** → open
**Theme settings** in the left sidebar → **App embeds** (in some theme-editor versions it's
the puzzle-piece **App embeds** icon) → switch **Cellexia Reviews** on → **Save**. The embed
ships **off** — enabling it is always your explicit choice. And as everywhere else in the app,
even an enabled embed shows visitors nothing until the store is **live** (§2); the private
preview and the theme editor show it fully.

**If you already use the blocks**: keep using them — nothing double-renders. On any product
page where the Cellexia Reviews block is placed, the block wins and the embed's own widget
steps aside automatically. Enabling the embed alongside the blocks is still worthwhile purely
for the product-card badges.

### The settings

Expand the embed's row (▸) under App embeds to reach them:

| Setting | Default | What it does |
| --- | --- | --- |
| Show the review widget on product pages | On | Mounts the full review widget on every product page automatically — no app block needed. It appears right after the product information / add-to-cart area (see the placement setting below to override). |
| Widget placement (CSS selector, optional) | empty | Leave empty for automatic placement below the product information. Enter a CSS selector to mount the widget after a specific element instead — the widget is inserted after the first match. See "Finding a CSS selector" below. |
| Show stars under the product title | On | A compact star row with the review count under the product page's own title, linking down to the widget — the same idea as the Cellexia Star Badge block, and skipped automatically when that block is already on the page. Shows nothing while the product has no published reviews. |
| Show star badges on product cards site-wide | On | Adds star ratings next to product names on the home page, collections, and search results for products with published reviews. |
| Badge style | Stars and review count | **Stars and review count** shows the stars followed by the number of reviews in parentheses; **Stars only** drops the number. |
| Card title element (CSS selector, optional) | empty | Advanced: only needed if badges don't find your theme's product card titles automatically — enter the selector of the card-title element and badges attach right after it. |

### How badges pick your products up automatically

You never tell the app which products to badge. On every page, the widget script looks for
links to product pages, works out which products the page is showing, and asks the backend for
all of their ratings in **one** batched request (up to 48 products per page, answered from a
5-minute cache). Each card whose product has at least one published review gets a small star
badge right after its title; products without published reviews are simply left alone — the
card stays exactly as your theme made it. Grids that load more products as you scroll are
picked up too. The badge inherits the card's own text size and follows your design version
(§3, "Design") — Amazon-orange, Cellexia-ink or Luxe-gold stars, automatically.

While the store is **not live**, the badges do nothing at all for visitors — no badges, no
requests — exactly like the widget (§2).

### Finding a CSS selector (for the two optional overrides)

You only need this if the automatic placement or the automatic card detection doesn't suit
your theme. In Chrome/Edge/Firefox: right-click the element on your storefront (the element
the widget should follow, or a product card's title) → **Inspect** → read the highlighted
element's class in the panel, e.g. `product-info__blocks` or `card__heading`, and enter it
with a leading dot (`.product-info__blocks`, `.card__heading`). Your theme's developer can
supply these in seconds if in doubt — and if a selector never matches, the app quietly falls
back to the automatic behavior rather than breaking anything.

---

## 6. Overall reviews widget (brand-wide block)

The **Cellexia Overall Reviews** block shows your **whole brand's** reviews in one section —
typically on the home page: the combined rating across every product's published reviews, the
share of verified purchases, optional distribution bars, and your strongest reviews across
products, each linking to its product's review section. It is entirely optional and purely
additive: until you add the block to a page, nothing changes anywhere.

What shoppers see (all of it painted instantly, with no waiting on scripts):

- A centered header: the heading (default **"What our customers say"**), a large star row
  with the combined average ("4.8 out of 5"), and "Based on 12,438 reviews across our
  products". When at least **60%** of those reviews are verified purchases, a trust line
  appears: "93% from verified purchases" — below that share it is simply left out.
- Optionally, the familiar **clickable distribution bars**: clicking the 5-star bar swaps the
  cards for 5-star reviews only (one quick request), with an **All stars** chip to return to
  the featured set.
- The top-review cards — stars, bold headline, a short excerpt with **Read more**, the
  author, date and **Verified Purchase** badge, a small media indicator when the review has
  photos or video — and, when **Link each review to its product** is on, the product's name
  linking straight to that product's review section plus a "Read 6,214 reviews" link.
- Optionally, a button of your choice at the end (e.g. "Shop bestsellers").

If your store has **no published reviews yet**, the block renders nothing at all — no empty
frame — and the usual visibility rules apply unchanged: while the store is **Not live** (§2),
visitors see nothing and no data is served; the theme editor and your private preview show
the block fully.

### Adding the block in the theme editor

1. Shopify admin → **Online Store → Themes → Customize**.
2. Use the page selector at the top to open the page you want — usually **Home page** (any
   page whose template supports sections works).
3. In the left sidebar, click **Add section** (or **Add block** inside an existing section) →
   **Apps** → **Cellexia Overall Reviews**.
4. Position it like any theme section, adjust the settings below, **Save**.

### The block's settings

| Setting | Default | What it does |
| --- | --- | --- |
| Heading | "What our customers say" | The section heading. Translatable per language in Translate & Adapt, like the main widget's heading. |
| Number of reviews to show | 6 | How many review cards the block shows (3–12). |
| Layout | Grid | **Grid** — 1 column on phones, 2 from tablet width, 3 on desktop. **Carousel** — one swipeable row with previous/next arrows; shoppers without JavaScript can still scroll it natively. |
| Show rating distribution bars | On | The clickable 5→1-star bars under the header. |
| Link each review to its product | On | Adds the product name and the "Read N reviews" link to each card. Recommended: it is what turns the block into a path to your product pages. |
| Button label (optional) | empty | Text for the call-to-action button at the end of the block (e.g. "Shop bestsellers"). Leave empty for no button. |
| Button link | empty | Where the button goes — a collection, a product, any page. |

The block follows your design version (§3, "Design") automatically: Amazon-orange stars, the
Cellexia skin's uppercase heading and ink palette, or Luxe's serif heading and champagne-gold
stars.

### Which reviews appear — Auto vs Hand-picked

The reviews are chosen in the app, on the **Display order** page (§7), in its third card:
**"Overall reviews (homepage widget)"**. Two modes:

- **Auto** (the default) — as the option itself puts it: "Our ranking picks your strongest
  recent reviews across all products, max 2 per product." In plain language, the ranking
  looks at reviews rated 4 stars or better and prefers the ones shoppers voted helpful,
  Verified Purchases, reviews with photos or video, texts long enough to be convincing
  without rambling, and recent reviews over old ones. One rule keeps the section honest as a
  *brand* section: **never more than 2 reviews from the same product** — so your bestseller
  cannot crowd out the rest of the catalog. Only when too few reviews qualify does the bar
  relax from 4 stars to 3 — never lower.
- **Hand-picked** — choose the reviews yourself: the same picker you know from per-product
  featuring, but searching **all** products' published reviews (with a rating filter and a
  product column). Up to **12** reviews, shown in exactly the order you arrange with the
  ↑ / ↓ / Remove buttons. If you pick fewer than the block is set to show, the auto ranking
  fills the remaining slots (still at most 2 per product among the backfill); a picked review
  that later loses its published status simply drops out.

The fast path, same as product featuring: on any review's own page (**Reviews** → open the
review), **Feature on homepage** adds it to the hand-picked list in one click — **Unfeature**
removes it. The cap of 12 applies there too.

### Refreshing, and the one-minute note

The block's numbers update **automatically** whenever your reviews change — approvals,
imports, deletions, generation — batched so that even a large import re-syncs cheaply. When
you want the theme updated *right now* (say, after picking new favorites), press **Refresh
homepage data** on the same card; its help text states the contract: "updates automatically
as reviews change; changes appear within a minute." As everywhere else in the app, the
storefront caches review data for up to 60 seconds and the theme reads synced metafields — so
give any change up to a minute to appear, and refresh the page.

The card also shows a live stats preview — average, review count, verified share — so you can
see exactly what the block will display before your shoppers do.

**A note on Google**: this block intentionally adds **no structured data** to your home page.
Star data about your own brand on your own site is ignored by Google ("self-serving"
ratings), so there is nothing to gain and conflicts to lose — your product pages carry the
markup that earns stars in search. The full reasoning is in `docs/SEO.md`.

---

## 7. Review display order

Which reviews shoppers see first is yours to control. The **Display order** page (in the
app's navigation, between **Reviews** and **Bulk add**) does three things: sets a store-wide
default ranking system, overrides it per product where you want to, and lets you hand-pick
**featured reviews** that lead a product's list in exactly the order you arrange. (The same
page also hosts the **"Overall reviews (homepage widget)"** card — that one controls the
brand-wide block and is covered in §6.)

Out of the box, nothing changes: the default system is the Amazon-style ranking the widget
has always used, and no reviews are featured — you only need this page if you want something
different.

### The six ranking systems

The first card on the page — the default order for all products — offers six systems. Each
option comes with a one-line description and a small star-row example right on the page, so
you can pick without memorizing this table:

| System | Which reviews shoppers see first |
| --- | --- |
| Amazon-style top *(the default)* | The reviews shoppers found most helpful — exactly how the widget has always ranked "Top reviews": most helpful votes first, Verified Purchases breaking ties, newest after that. |
| Top positive | The highest star ratings first, so your best reviews lead; among equal ratings, the most helpful. |
| Most recent | Newest first, nothing else considered. Good when freshness matters more than votes. |
| Verified purchases first | Reviews from confirmed buyers lead; within each group, the most helpful first. |
| Photos & videos first | Reviews with the most photos and videos lead — strongest for visually-driven products. |
| Balanced | An honest, Amazon-style mix: three positive reviews (4–5 stars), then one critical review (1–3 stars), repeating down the list. Shoppers can see at a glance that nothing is being hidden. |

Below the choice sit two **boost** checkboxes — **Show Verified Purchase reviews first** and
**Show reviews with photos first** — which push the matching reviews ahead of the rest of
whichever system you picked. They don't apply to Balanced (its fixed positive/critical rhythm
is the point).

As the card's own help text says: **"Applies to every product unless overridden below.
Changes appear on the storefront within a minute."** — the storefront caches review data for
60 seconds, so a display change can take up to a minute to show on product pages. The
server-rendered ratings and top reviews re-sync immediately when you save.

### Per-product overrides & featured reviews

Under the default card, a table lists every product that has at least one published review:
its published-review count, the system in effect ("Default (Amazon-style)" until you override
it), and how many featured reviews it has. Click **Edit display** on a row to open that
product's editor:

1. **System** — keep **Use the store default**, or pick one of the six systems for this
   product only.
2. **Featured reviews (shown first)** — the hand-picked reviews that lead this product's
   list, in the exact order shown. Each row displays the stars, a short excerpt, the author
   and the date, with **↑** / **↓** / **Remove** buttons to reorder or drop (buttons, not
   drag-and-drop — they work with a keyboard too). Under **Add reviews**, search the
   product's published reviews by text or author, filter by rating, and press **Add** on the
   ones you want. **Up to 10 reviews can be featured per product** — the editor enforces the
   cap and says so.
3. Save. The product page follows within the minute (same 60-second cache as above);
   reverting to the store default with no featured reviews simply removes the override.

As the editor's banner puts it: **"Featured reviews always appear first under the default
sort. Shoppers can still re-sort and filter."** In practice that means: featured reviews lead
page 1 while the shopper is on the default "Top reviews" sort with no filter or search
active. The moment they switch to Most recent, type a search, or apply any filter (stars,
verified, photos, …), the shopper's choice wins — featuring never overrides an explicit
filter. Only published reviews can be featured, and a featured review that later loses its
published status (rejected, deleted) drops out of the list by itself.

Your chosen system and featured reviews also drive the **server-rendered top reviews** — the
three reviews baked into the page source and into the Google structured data — so what search
engines index matches what shoppers see live.

### The fast path: featuring while moderating

You don't have to open the Display order page to pin a great review. On any review's own page
(**Reviews** → open the review), the **Feature on product page** action adds it to its
product's featured list in one click — **Unfeature** takes it back out. The same cap of 10
per product applies there too.

---

## 8. Moderation workflow

Every review is in one of four states: **Pending**, **Published**, **Rejected**, **Spam**.
Only Published reviews appear on the storefront or count toward the rating.

1. New storefront submissions arrive as **Pending** (or **Published** if auto-publish is on).
2. Work from **Dashboard → Needs attention** or the **Reviews** page. Tabs filter by status;
   you can also filter to reviews flagged by shopper reports, or by **Source** — Storefront,
   CSV import, Bulk add, or Synthetic (reviews from before version 1.4 count as Storefront).
   Synthetic test reviews additionally carry a blue **Synthetic** badge (§12). Search, sort,
   and use bulk actions (Approve, Reject, Mark as spam, Delete) for volume.
3. Click a review to open it: full text, photos/videos, the shopper's structured answers (age
   range, skin concerns, time using, results seen), whether and how the purchase was verified,
   and its helpful/report counts. Approve, Reject, Mark as spam, or Delete from here. A
   published review worth showing off can also be pinned to the top of its product page right
   here — the **Feature on product page** action (§7, "Review display order") — or promoted
   into the brand-wide homepage block with **Feature on homepage** (§6, "Overall reviews
   widget").
4. **Shopper reports**: when 3 different shoppers report a published review, it automatically
   returns to Pending and shows up in "Needs attention" for a second look.
5. Ratings, the distribution bars, the star badge and Google data update automatically whenever
   a review's status changes.

**Reading foreign-language reviews**: on the review page, use the translation preview select
to read the review in your own language before moderating (requires a translation provider).

---

## 9. Replying to reviews

Replying is how Cellexia answers customers publicly.

1. **Reviews** → open the review.
2. Type your answer in the **Reply** field and save. A preview shows exactly what the
   storefront will display.
3. On the product page the reply appears beneath the review as
   "**Response from Cellexia**" with the date (the name comes from *Brand display name* in
   Settings → General).

Editing the reply text and saving again updates it; clearing it removes the reply.

---

## 10. Importing reviews (Judge.me, Loox, Yotpo, CSV)

Bringing reviews from a previous app — or from any spreadsheet: **Import / Export** page.

### The flow

1. Optional but recommended: click **Download CSV template** to get the generic format —
   the header row plus two realistic example rows you can replace with your data.
2. Upload your CSV. The app **auto-detects the source preset** from the file's headers
   ("Detected: Judge.me") — or pick it yourself: **Judge.me**, **Loox**, **Yotpo**, or
   **Generic template** (the column layout below).
3. If your file contains ambiguous dates (say `04/05/2025` — April or May?), pick the
   **Date format** (default: ISO / auto). Dates with a day above 12 resolve on their own.
4. The **whole file is validated before anything is written**: you see how many rows are
   valid and how many have errors, with the first 50 errors in a table (row number, column,
   what's wrong). More than 50? **Download full error report** gets you all of them as a CSV
   to fix in your spreadsheet.
5. Choose the **default status** for imported reviews (Published or Pending), then click
   **Import**. Large files import in chunks with a progress bar ("Imported X of Y") — leave
   the tab open until it finishes.
6. A summary banner reports what happened: **created**, **duplicates skipped**, **errors**.
   Ratings, distribution bars and metafields recalculate for every affected product.

### Duplicates

A row is skipped as a duplicate when a review already exists for the same product from the
same author (matched by email — or by name when there is no email) with identical review
text. Re-running an import is therefore safe: already-imported rows are counted as
"duplicates skipped", not created twice.

### The generic template, column by column

Column names are exact (lower-case, underscores). Multi-value columns use `|` between values.
An invalid option key (a typo in `skin_concerns`, say) makes that **row** an error — it is
reported, never silently dropped.

| Column | Required | Accepted values / format |
| --- | --- | --- |
| `product_id` | One of these two | The numeric Shopify product id (the number in the product's admin URL). |
| `product_handle` | One of these two | The product's URL handle, e.g. `renewal-cream`. |
| `rating` | Yes | Whole number 1–5. |
| `title` | No | Review headline, up to 150 characters. |
| `body` | Yes | The review text, up to 5000 characters. |
| `author_name` | Yes | Reviewer display name, up to 80 characters. |
| `author_email` | No | Used for duplicate detection and verified-purchase lookup. Never shown publicly. |
| `date` | No | Review date: ISO 8601, `YYYY-MM-DD`, `DD/MM/YYYY` or `MM/DD/YYYY` (see the Date format select). Empty = now. |
| `verified` | No | `true` / `false`, `1` / `0`, `yes` / `no`. |
| `language` | No | One of the 17 store locale codes (`en`, `fr`, `de`, `da`, `sv`, `fi`, `nl`, `it`, `es`, `ar`, `pl`, `pt-PT`, `ja`, `nb`, `ro`, `hu`, `el`). Default `en`. |
| `country` | No | Two-letter country code (`US`, `FR`, …). |
| `variant_title` | No | The purchased variant's name, e.g. `50 ml`. |
| `age_range` | No | One key: `under_25`, `25_34`, `35_44`, `45_54`, `55_64`, `65_plus`. |
| `skin_concerns` | No | `\|`-separated keys: `fine_lines`, `dark_spots`, `dryness`, `dullness`, `firmness`, `texture`, `sensitivity`, `redness`, `pores`, `dark_circles`. |
| `time_using` | No | One key: `lt_1w`, `w1_4`, `m1_3`, `m3_6`, `gt_6m`. |
| `results_seen` | No | `\|`-separated keys: `smoother`, `fewer_lines`, `firmer`, `radiance`, `even_tone`, `hydration`, `calmer`, `too_early`. |
| `helpful_count` | No | Whole number ≥ 0 — the review's helpful votes. |
| `reply` | No | Your public reply to the review. |
| `reply_date` | No | Same formats as `date`. Empty with a reply present = review date + 2 days. |
| `image_urls` | No | Up to 5 image web addresses, `\|`-separated. |
| `video_url` | No | One video web address. |
| `status` | No | `PUBLISHED`, `PENDING`, `REJECTED` or `SPAM`. Empty = the default status you chose at import time. |

### Notes

- Products are matched by `product_id` or `product_handle` in one batched lookup; a row whose
  product can't be found becomes an error naming the bad reference.
- Photos and videos in imported reviews keep pointing at their original web addresses (they
  are not copied to Shopify). They display fine as long as those addresses stay online — a
  known limitation worth remembering before you close the old app's account. (Reviews added
  on the **Bulk add** page can upload files properly — see §11.)
- Imported reviews keep their original dates and their verified flag when the source file has
  one; the presets map each old app's columns onto the template automatically.

---

## 11. Bulk add (typing reviews straight into the admin)

For a handful — or a few dozen — reviews you have on paper, in emails, or from a photoshoot,
the **Bulk add** page is faster than building a CSV. It works on **one product at a time**
(migrating many products at once is what CSV import is for; the page says so too).

1. **Pick the product** at the top (product picker).
2. Fill the **review composer**: star rating, title, body, author name, email, date (defaults
   to today), verified checkbox, language, variant, the four structured skincare answers
   (age range, skin concerns, time using, results seen), an optional reply with its date, and
   media — up to 5 images + 1 video per review, either as web addresses or as direct file
   uploads (files land in your own Shopify Files, same size limits as storefront submissions:
   8 MB per image, 80 MB for the video; both kinds can mix).
3. **Add to list** — the review joins a staging list on the page. Edit or remove staged rows
   freely; nothing is saved yet. The list lives only in this browser tab, so the page warns
   you before you leave it with unsaved rows.
4. **Save** — choose whether the reviews arrive as **Published** or **Pending**, then save.
   Long lists save in chunks with a progress readout. Rows that fail stay in the list with
   their error so you can fix and retry; saved rows clear. Ratings and metafields re-sync for
   the product when the save finishes.

---

## 12. QA data (synthetic reviews)

The **QA data** page generates realistic, AI-written test reviews so you can check the widget
with believable content — layout with long and short texts, the filters, translations, the
three design versions — before any real reviews exist. It uses the Anthropic API key from
**Settings → AI summary**; without a key the generator refuses to run.

> **Warning — read this before generating.** Synthetic reviews look completely real in the
> widget. They are labeled only in this admin (a blue **Synthetic** badge, the Source filter,
> a banner on their review pages) — **shoppers can never tell them apart from real reviews.**
> Delete every batch before going live to real customers (§2). The Dashboard shows a warning
> banner whenever published synthetic reviews exist, and it turns critical once the store is
> live.

### Generating reviews

Pick the product, then tune the knobs — the number of reviews, the target **average star
rating** (a realistic whole-star distribution is derived and previewed), **verified-purchase
%**, **languages** (reviewer names and review text follow each language), **merchant replies
%** (written on-brand, using your Brand display name), maximum **helpful votes** (long-tail:
most reviews get few), a **date range** the reviews are backdated into, whether to assign real
**product variants**, whether to fill the **structured answers** (coherently with each
review's rating), and the **status** they are created with (Published to see them in the
widget immediately, or Pending). Over 36 different reviewer personas keep the tone and length
varied.

There is no longer an upper limit on the number of reviews (versions before 1.7.0 capped a
batch at 200). Above **500** reviews the page shows an inline warning with the estimated cost
and duration of the run, and above **5,000** the confirmation asks you to re-confirm the
figures ("Generate 8,000 reviews? Estimated $X and ~Y.") before anything starts.

**Generation runs in the background.** Clicking **Generate** starts a job on the server and
returns immediately — a toast confirms: "Generation started — you can leave this page". From
that moment the run no longer depends on your browser: move to any other admin page, or close
the tab entirely, and the reviews keep being created. The form stays filled, so you can start
a second, different job right away — for the same product or another one. Several jobs run
simultaneously: the app works on up to two at a time for your store and queues the rest in
order.

### Estimating cost and time first

Next to **Generate** sits an optional **Estimate cost** button — generation never requires
pressing it, but for larger runs you will want to. It shows an inline summary like
"≈ 12,400 input + 20,800 output tokens · **≈ $0.35** · about 4 minutes", with a subdued
second line naming what the numbers are based on — "Based on your shop's last 27 generated
chunks (216 reviews) with this model" once the app has measured your store's own real
generation speed, or "Based on a token count
of one sample batch" before enough history exists — and the pricing that was applied
(including the Claude Sonnet 5 introductory-pricing note while that rate lasts). Change the
number of reviews and the estimate on screen refreshes by itself.

**Estimates are approximate — treat them as a ballpark, not an invoice.** Actual token usage
varies with the product, the languages and the personas drawn for each review. The **actual
cost** of every job, computed from its real token usage, appears in the jobs table (below)
once the job has finished. Time estimates improve as you use the generator: they are
calibrated from your own store's measured speed, and while a job runs, its remaining-time
readout is recomputed from that job's actual pace — so it self-corrects within the first
minute.

### Following and managing jobs

The **Generation jobs** card on the QA data page lists your 50 newest jobs: status, product,
progress (created / target, with a progress bar), the remaining time while a job runs, the
elapsed time once it finished, and the job's actual cost once known. The card refreshes
itself every few seconds while anything is running. Row actions:

- **Cancel** — for a queued or running job. The job finishes the handful of reviews it was
  writing at that moment, then stops. Reviews it already created are **kept** (delete the
  batch if you don't want them).
- **Retry remaining** — for a failed or cancelled job that didn't reach its target: re-queues
  just the missing reviews into the same batch. A retried job never overshoots the number you
  originally asked for.
- **View reviews** — opens the Reviews list filtered to the job's batch.
- **Delete batch** — removes the job's reviews, exactly like deleting the batch from the
  "Existing synthetic data" card below.

While at least one job is active, **every admin page** shows a compact banner below the
navigation — "Generating reviews — 148 of 500 · about 7 minutes left" — with a link back to
**QA data**, so progress stays visible wherever you are in the app. Dismissing it hides it
for the current session only.

Robustness, in plain terms: if a few review-chunks fail along the way (a network blip, a slow
response), the job retries them once, then skips them and keeps going — the job row reports
honestly what was created and what failed. A job only ends as failed outright when it could
not create any reviews at all or the Anthropic key is missing or invalid — **Retry remaining**
picks it up from there. And if the app's server restarts mid-run, the job resumes where it
left off: already-created reviews are kept and the target is never exceeded.

### Managing batches

Every job writes into its own batch (one batch id per job). The "Existing synthetic data"
card lists each batch — product, review count, generated at — with **View in Reviews** (opens
the Reviews list filtered to that batch, "Batch: xxxxxxxx" chip) and **Delete batch**
(confirmation dialog). Deleting a batch also removes its job from the jobs table, cancelling
it first if it is still running. **Delete ALL synthetic reviews** removes everything the
generator ever made, behind a double confirmation (you type `DELETE`). Every deletion
recalculates the affected products' ratings, distribution bars and metafields — no trace
remains.

---

## 13. Quick answers

- **Anything storefront-related** → run the **Storefront connection** test on the Dashboard
  first (§1). It names the broken link in the chain and shows the fix, instead of leaving you
  to guess.
- **No stars anywhere, on any product** → almost always because the app has no published
  reviews of its own yet (the *Review data* check says so). Reviews still living in a previous
  review app are invisible here until you import them — §10, §11 or §12.
- **The theme editor says reviews couldn't be loaded** → fixed in version 1.6.0; if it persists,
  run the connection test — *Preview token round-trip* will point at it — and use
  **Settings → Data → Regenerate preview link** (§2). Shoppers never see that message.
- **Nothing shows on the product page** → the store may not be **live** yet (check the
  Dashboard banner — §2), neither the block is added nor the app embed enabled in the theme
  editor (§4/§5; Dashboard setup guide, step 1), or the product has no published reviews.
- **No star badges on my product cards** → first, make sure you are on version **1.8.0 or
  later**. Versions 1.5.0–1.7.0 carried a genuine bug that hid the card badges on every
  store, no matter how correctly everything was set up: when your theme builds a page,
  Shopify wraps the small piece of app code that carries the app's internal address in
  invisible HTML comments, and those comments corrupted the address the badge script calls —
  so its requests never reached the app. (The main review widget survived the same corruption
  only by quietly detecting the bad address and retrying, which cost every product page a
  wasted request.) Version 1.8.0 cleans the address everywhere it is used and teaches the
  badge script to recover the same way the widget does. Once on 1.8.0, the remaining reasons
  are the ordinary ones: the app embed isn't enabled, or its "Show star badges on product
  cards site-wide" setting is off (§5); the store isn't live yet (§2); or those products have
  no published reviews — badges only appear for reviewed products. Unusual theme? See
  "Card title element (CSS selector, optional)" in §5.
- **The Overall reviews block shows nothing on my home page** → the store may not be live
  yet (§2 — the theme editor and your private preview always show it), or the store has no
  published reviews at all — the block deliberately renders nothing rather than an empty
  frame (§6). Just changed the picks or imported reviews? Give it a minute, or press
  **Refresh homepage data** on the Display order page (§6).
- **Reviews aren't in the order I set** → the storefront caches review data for 60 seconds,
  so give a display change up to a minute (§7). Also remember that featured reviews and your
  chosen system apply to the default "Top reviews" view: a shopper who has re-sorted,
  searched or filtered sees their own choice instead — that is by design. And check whether
  the product has a per-product override that differs from the store default (§7, the
  per-product table's "system in effect" column).
- **No "Customers say" section** → no Anthropic API key in Settings → AI summary, or the
  product doesn't have enough published reviews yet (threshold setting, default 5).
- **No stars in Google** → see `docs/SEO.md`; it takes valid data *and* time, and Google
  decides case by case.
- **Test reviews are showing to real shoppers** → they are synthetic QA data still published
  while the store is live. **QA data** page → delete the batch (or all synthetic reviews) —
  §12. The Dashboard's critical banner links straight there.
- More in `docs/FAQ.md`.
