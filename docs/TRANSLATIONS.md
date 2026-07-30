# Translations guide

How Cellexia Reviews speaks 17 languages, how to change any wording, and how this interacts
with Shopify's Translate & Adapt app.

The 17 storefront languages: **en** (default), **fr**, **de**, **da**, **sv**, **fi**, **nl**,
**it**, **es**, **ar**, **pl**, **pt-PT**, **ja**, **nb**, **ro**, **hu**, **el**.

There are **three separate translation layers**. Knowing which layer a piece of text belongs to
tells you where to change it:

| Layer | Example | Where it's translated |
| --- | --- | --- |
| 1. Widget UI strings | "Helpful", "Verified Purchase", "See more reviews" | Locale files shipped inside the app's theme extension (§1) |
| 2. Merchant-entered block settings | The widget heading you typed in the theme editor | Translate & Adapt (§3) |
| 3. Review content written by shoppers | The review text itself | Live translation via Claude / DeepL / Google (§4) |

---

## 1. Widget UI strings: the extension locale files

All interface text lives in the theme app extension's locale files:

```
extensions/cellexia-reviews/locales/
  en.default.json          ← master storefront strings (customer-facing)
  en.default.schema.json   ← master theme-editor strings (merchant-facing labels)
  fr.json + fr.schema.json
  de.json + de.schema.json
  … one pair per language (ar, da, el, es, fi, hu, it, ja, nb, nl, pl, pt-PT, ro, sv)
```

**How they are served:** Shopify does this automatically. When a shopper browses the store in
French, every string the widget renders comes from `fr.json`; the theme editor labels a
French-speaking merchant sees come from `fr.schema.json`. If a storefront language has no
matching file, Shopify falls back to `en.default.json`. There is nothing to configure — the
storefront language selector drives it. (Shopify docs:
[theme app extension configuration](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration),
[theme locale files](https://shopify.dev/docs/storefronts/themes/architecture/locales).)

**Important platform limitation (verified against current Shopify docs):** merchants cannot
edit theme-app-extension storefront locale strings — not in the theme editor and not in
Translate & Adapt. These strings never appear in Translate & Adapt at all. Changing them is a
developer task on the files themselves, as follows.

### Changing a string (developer task)

1. Find the key in `extensions/cellexia-reviews/locales/en.default.json` — keys are grouped
   (`cellexia.widget.*`, `cellexia.review.*`, `cellexia.form.*`, option labels under
   `cellexia.age.*`, `cellexia.skin.*`, `cellexia.time.*`, `cellexia.results.*`, and the
   report-reason labels under `cellexia.report_dialog.*`).
2. Edit the value in the language file(s) you care about (e.g. `fr.json`). Rules:
   - Keep the key structure identical to the English master — never add/remove/rename keys.
   - Keep placeholders **verbatim**: `[[count]]`, `[[date]]`, `[[name]]`, etc. are replaced at
     runtime; a translated string that drops one will show incomplete text.
   - Keep plural sub-keys (`one` / `few` / `many` / `other`) appropriate to the language —
     Polish, Romanian and Arabic use more categories than English.
3. Validate: `npm run check:locales` — it fails with a readable diff on any missing key, lost
   placeholder, invalid JSON or empty value.
4. Publish: `npm run deploy` (pushes the extension to Shopify; storefront picks it up
   immediately).

Heads-up: app updates ship fresh locale files, so keep a note of custom wording changes and
re-apply them after updating (`docs/UPDATE.md`).

---

## 2. What Translate & Adapt does NOT translate here

Shopify's **Translate & Adapt** app translates Shopify-owned resources (products, pages, theme
content…). For this app specifically:

- Widget UI strings (layer 1): **not visible** in Translate & Adapt — they are served from the
  extension's locale files, already translated into all 17 languages.
- Review content (layer 3): **not visible** in Translate & Adapt — reviews are app data, not a
  Shopify translatable resource.

The one thing Translate & Adapt **does** handle is layer 2:

## 3. Translating the block heading (merchant click-path)

The widget's **Heading** setting (default "Customer reviews") ships pre-translated: each
language's locale file carries its own default, so if you never touch the setting, every
language already shows the right heading.

The moment you **type your own heading** in the theme editor (e.g. "What our customers say"),
that typed value is stored in your theme in one language only — and theme content is exactly
what Translate & Adapt can translate. To translate your custom heading:

1. Make sure the target languages are added and published: Shopify admin → **Settings →
   Languages**.
2. Go to **Apps → Translate & Adapt** (free Shopify app; install it from the Shopify App Store
   if it isn't there yet).
3. At the top, **select the language** to translate into.
4. In the resource list, open the **Online Store → Theme** content for your published theme.
5. Locate the product template's content — the Cellexia Reviews block appears among the
   template's sections/blocks with its **Heading** field showing your custom text.
6. Enter the translation in the target-language column and click **Save**.

Repeat per language. The same path covers the other text you might customize on the block in
future. (Shopify help:
[Translate & Adapt](https://help.shopify.com/en/manual/international/translate-adapt-app).)

Practical tip: if the shipped default heading is fine, don't override it — you keep 17
professionally translated headings for free and skip this section entirely.

---

## 4. Review-content translation (Claude / DeepL / Google)

Completely separate from all of the above: the text **shoppers wrote** is translated on demand,
live on the storefront.

- A review whose language differs from the page language shows a **Translate** link; there is
  also **Translate all reviews** above the list. Shoppers can switch back via **See original**.
- The translation provider is chosen in the app: **Settings → Translation** — Anthropic
  (default, uses the Claude API key), DeepL, Google, or Off (hides the links). Results are
  cached, so each review+language pair is paid for once.
- Translations are kept in a real shopper's voice (since 1.11.0): the translator preserves the
  reviewer's casual register and avoids AI-flavored wording, and every served translation —
  whichever provider produced it, and even if it was cached before 1.11.0 — passes a
  deterministic em/en-dash scrub (Japanese gets 、, Arabic gets ،, other languages ", ").
  Reviews shown in their original language are never altered.
- The AI "Customers say" summary is generated once in the store's default language and
  localized into other languages on demand, again cached per language.
- The merchant can preview any review translated into their own language on the review's admin
  page before moderating it.

UI strings are never machine-translated — layer 1 always comes from the shipped, human-reviewed
locale files.

---

## 5. Right-to-left (Arabic)

RTL is supported end to end, automatically:

- When the storefront language is Arabic, the widget root renders with `dir="rtl"` and the
  whole layout mirrors (stars, distribution bars, chips, dialogs, media strip scroll).
- The stylesheet uses CSS logical properties throughout, so no extra configuration or RTL
  stylesheet is needed.
- `ar.json` uses Arabic plural categories (including `few`/`many`), validated by
  `npm run check:locales`.

---

## 6. Reference: verified sources

- [Theme app extension configuration — locale files, merchant-editability](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration)
- [Translate & Adapt — Shopify Help Center](https://help.shopify.com/en/manual/international/translate-adapt-app)
- [Theme locale files](https://shopify.dev/docs/storefronts/themes/architecture/locales)
- [Translatable resources (theme JSON templates)](https://shopify.dev/docs/api/admin-graphql/latest/enums/TranslatableResourceType)
