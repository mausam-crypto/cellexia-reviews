# Configuration guide

Audience: the merchant. Everything you can configure in Cellexia Reviews, and the day-to-day
workflows: moderating, replying, importing.

Open the app: Shopify admin → **Apps → Cellexia Reviews**. The app has six pages, reachable
from its navigation menu: **Dashboard**, **Reviews**, **Bulk add**, **Import / Export**,
**QA data**, **Settings**.

---

## 1. Dashboard

- **Status banner** — the very top of the Dashboard always shows whether the review widget is
  **Live** or **Not live** for store visitors, with the buttons to preview and to switch. This
  is where going live happens — see §2, "Going live & previewing".
- **Synthetic-data warning** — shown whenever published synthetic test reviews exist (§9,
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

---

## 2. Going live & previewing

Your storefront is always in one of two states:

- **Not live** — every new install starts here. Visitors see **nothing at all**: no widget, no
  star badge, no review data, no Google structured data. You can take your time — add the
  blocks, adjust settings, import reviews — without shoppers noticing any change. (The **theme
  editor always shows the full widget**, live or not, so you can place and configure the
  blocks.)
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

**Before you go live**: if you generated synthetic test reviews (§9, "QA data"), delete every
batch first. Published synthetic reviews are indistinguishable from real ones on the
storefront — they are labeled only inside this admin — and the Dashboard banner turns critical
the moment you go live with any still published.

**Going live**: click **Go live** and confirm ("Make Cellexia Reviews visible to all store
visitors?"). That's it — a "You're live!" toast confirms, and the widget appears for everyone
within about a minute (the state is synced to a shop metafield, like the design version).
**Switch off** does the reverse, after its own confirmation ("Hide the review widget from all
store visitors? Your data is kept.") — reviews, settings, imports and replies are all
preserved, and you can go live again whenever you want.

**Regenerating the preview link**: shared a preview link with someone (an agency, a colleague)
and want to cut their access? **Settings → Data → Regenerate preview link**. Old links stop
working immediately; the Dashboard's preview button always uses the current link. A toast
confirms: "Preview link regenerated — old links no longer work."

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

Controls the shopper-facing "Translate" links on reviews written in another language.

| Setting | Default | What it does |
| --- | --- | --- |
| Provider | Anthropic | Anthropic / DeepL / Google / Off. Anthropic reuses the API key above. Off removes all translate links. |
| DeepL API key | empty | Only needed if provider is DeepL (get one at deepl.com, API plans). |
| Google API key | empty | Only needed if provider is Google (Google Cloud Translation API key). |
| Show “Translate” buttons on the storefront | On | Hide the translate links without changing provider, if you ever need to. |

Note: this translates **review content** on demand. The widget's own interface (buttons,
labels) is already translated into your 17 store languages — see `docs/TRANSLATIONS.md`.

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
  all reviews (the template columns — see §7 —
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

The theme editor always shows the full widget while you work in it, even when the store is
**Not live** — placing and styling the blocks never requires going live first (§2).

---

## 5. Moderation workflow

Every review is in one of four states: **Pending**, **Published**, **Rejected**, **Spam**.
Only Published reviews appear on the storefront or count toward the rating.

1. New storefront submissions arrive as **Pending** (or **Published** if auto-publish is on).
2. Work from **Dashboard → Needs attention** or the **Reviews** page. Tabs filter by status;
   you can also filter to reviews flagged by shopper reports, or by **Source** — Storefront,
   CSV import, Bulk add, or Synthetic (reviews from before version 1.4 count as Storefront).
   Synthetic test reviews additionally carry a blue **Synthetic** badge (§9). Search, sort,
   and use bulk actions (Approve, Reject, Mark as spam, Delete) for volume.
3. Click a review to open it: full text, photos/videos, the shopper's structured answers (age
   range, skin concerns, time using, results seen), whether and how the purchase was verified,
   and its helpful/report counts. Approve, Reject, Mark as spam, or Delete from here.
4. **Shopper reports**: when 3 different shoppers report a published review, it automatically
   returns to Pending and shows up in "Needs attention" for a second look.
5. Ratings, the distribution bars, the star badge and Google data update automatically whenever
   a review's status changes.

**Reading foreign-language reviews**: on the review page, use the translation preview select
to read the review in your own language before moderating (requires a translation provider).

---

## 6. Replying to reviews

Replying is how Cellexia answers customers publicly.

1. **Reviews** → open the review.
2. Type your answer in the **Reply** field and save. A preview shows exactly what the
   storefront will display.
3. On the product page the reply appears beneath the review as
   "**Response from Cellexia**" with the date (the name comes from *Brand display name* in
   Settings → General).

Editing the reply text and saving again updates it; clearing it removes the reply.

---

## 7. Importing reviews (Judge.me, Loox, Yotpo, CSV)

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
  on the **Bulk add** page can upload files properly — see §8.)
- Imported reviews keep their original dates and their verified flag when the source file has
  one; the presets map each old app's columns onto the template automatically.

---

## 8. Bulk add (typing reviews straight into the admin)

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

## 9. QA data (synthetic reviews)

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

**Generating a batch**: pick the product, then tune the knobs — number of reviews (up to 200
per batch), the target **average star rating** (a realistic whole-star distribution is derived
and previewed), **verified-purchase %**, **languages** (reviewer names and review text follow
each language), **merchant replies %** (written on-brand, using your Brand display name),
maximum **helpful votes** (long-tail: most reviews get few), a **date range** the reviews are
backdated into, whether to assign real **product variants**, whether to fill the
**structured answers** (coherently with each review's rating), and the **status** they are
created with (Published to see them in the widget immediately, or Pending). Generation runs
in chunks with a progress readout; over 36 different reviewer personas keep the tone and
length varied.

**Managing batches**: every run gets a batch id. The "Existing synthetic data" card lists each
batch — product, review count, generated at — with **View in Reviews** (opens the Reviews list
filtered to that batch, "Batch: xxxxxxxx" chip) and **Delete batch** (confirmation dialog).
**Delete ALL synthetic reviews** removes everything the generator ever made, behind a
double confirmation (you type `DELETE`). Every deletion recalculates the affected products'
ratings, distribution bars and metafields — no trace remains.

---

## 10. Quick answers

- **Nothing shows on the product page** → the store may not be **live** yet (check the
  Dashboard banner — §2), the block isn't added in the theme editor yet (Dashboard setup
  guide, step 1), or the product has no published reviews.
- **No "Customers say" section** → no Anthropic API key in Settings → AI summary, or the
  product doesn't have enough published reviews yet (threshold setting, default 5).
- **No stars in Google** → see `docs/SEO.md`; it takes valid data *and* time, and Google
  decides case by case.
- **Test reviews are showing to real shoppers** → they are synthetic QA data still published
  while the store is live. **QA data** page → delete the batch (or all synthetic reviews) —
  §9. The Dashboard's critical banner links straight there.
- More in `docs/FAQ.md`.
