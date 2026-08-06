/**
 * Cellexia Reviews — review translation service.
 *
 * Translates reviews (title, body, brand reply) into a target SHOP_LOCALES
 * locale using the provider configured in settings. Storefront callers get
 * PUBLISHED reviews only (the default); the authenticated admin moderation
 * preview (SPEC §11) passes `includeUnpublished: true` to translate reviews
 * in any status. Providers:
 *   - anthropic : reuses the Claude API key from the AI settings
 *   - deepl     : api-free.deepl.com for ":fx"-suffixed keys, api.deepl.com
 *                 otherwise, with a one-shot fallback to the other host on
 *                 auth errors
 *   - google    : Cloud Translation v2 (translation.googleapis.com)
 *   - off       : cache-only
 *
 * Results are cached per (reviewId, target) in TranslationCache and served
 * from cache first. Missing API keys, provider failures and unknown ids all
 * degrade gracefully — the function returns whatever it could translate and
 * never throws to the route.
 *
 * v1.11 dash/register hygiene: translated text must read like a shopper wrote
 * it in the target language — the Claude system prompt bans em/en dashes and
 * assistant-flavored wording, and scrubDashes (the same deterministic
 * sanitizer the QA generator uses, shared from synthetic-prompts.server.ts)
 * runs on EVERY served translation regardless of provider — including cache
 * hits, so rows cached before v1.11 come out clean too. Same-language
 * pass-throughs are the reviewer's original words, never a translation, and
 * are deliberately not scrubbed.
 */
import type { Review } from "@prisma/client";
import prisma from "~/db.server";
import { SHOP_LOCALES } from "~/types/cellexia";
import { callClaudeWithUsage, extractJson } from "./ai.server";
import { getSettings } from "./settings.server";
import { thinkingParamFor } from "./pricing.server";
import { recordSpend } from "./spend.server";
import { scrubDashes } from "./synthetic-prompts.server";

/** Per-review translation payload returned to the proxy route (§6). */
export interface ReviewTranslation {
  title?: string | null;
  body: string;
  reply?: string | null;
}

const MAX_IDS = 20;

/** Options for translateReviews. */
export interface TranslateReviewsOptions {
  /**
   * When true, non-PUBLISHED (PENDING/REJECTED/SPAM) reviews are translated
   * too. Only the authenticated admin translation preview (app.reviews.$id)
   * may set this — storefront proxy callers MUST keep the default
   * published-only behaviour so unpublished content never leaks (§6).
   */
  includeUnpublished?: boolean;
}

export async function translateReviews(
  shop: string,
  ids: string[],
  target: string,
  options: TranslateReviewsOptions = {},
): Promise<Record<string, ReviewTranslation>> {
  const result: Record<string, ReviewTranslation> = {};
  if (!Array.isArray(ids) || ids.length === 0) return result;
  if (!(SHOP_LOCALES as readonly string[]).includes(target)) return result;

  const uniqueIds = [...new Set(ids.filter((id) => typeof id === "string" && id))].slice(
    0,
    MAX_IDS,
  );
  if (uniqueIds.length === 0) return result;

  const reviews = await prisma.review.findMany({
    where: {
      id: { in: uniqueIds },
      shop,
      ...(options.includeUnpublished ? {} : { status: "PUBLISHED" }),
    },
  });
  if (reviews.length === 0) return result;

  // Reviews already written in the target language pass through unchanged.
  const toTranslate: Review[] = [];
  for (const review of reviews) {
    if (review.language === target) {
      result[review.id] = { title: review.title, body: review.body, reply: review.reply };
    } else if (!scrubDashes(review.body, target)) {
      // Dash-only source body: no translation can survive the scrub, and
      // retrying can never fix it — skip so the provider is never billed for
      // it on every request (the widget simply shows the original).
    } else {
      toTranslate.push(review);
    }
  }
  if (toTranslate.length === 0) return result;

  // Cache first.
  const cached = await prisma.translationCache.findMany({
    where: { target, reviewId: { in: toTranslate.map((r) => r.id) } },
  });
  const cachedByReview = new Map(cached.map((c) => [c.reviewId, c]));
  const missing: Review[] = [];
  for (const review of toTranslate) {
    const hit = cachedByReview.get(review.id);
    // Cache rows written before v1.11 may carry em/en dashes — scrub on the
    // way out so the guarantee holds without a cache migration.
    const clean = hit && hit.body
      ? scrubTranslation({ title: hit.title, body: hit.body, reply: hit.reply }, target)
      : null;
    if (clean) {
      result[review.id] = clean;
    } else {
      missing.push(review);
    }
  }
  if (missing.length === 0) return result;

  const settings = await getSettings(shop);
  let translated: Record<string, ReviewTranslation> = {};
  // v1.20 (SPEC-1.20 §3): Claude translations are billed to the same API key
  // as curation, so they belong on the same ledger — otherwise a curation run
  // in "all reviews, translated" mode spends money the ceiling cannot see.
  const claudeUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    switch (settings.translationProvider) {
      case "anthropic":
        translated = await translateWithAnthropic(
          settings.anthropicApiKey,
          settings.aiModel,
          missing,
          target,
          claudeUsage,
        );
        break;
      case "deepl":
        translated = await translateWithDeepl(settings.deeplApiKey, missing, target);
        break;
      case "google":
        translated = await translateWithGoogle(settings.googleApiKey, missing, target);
        break;
      default:
        translated = {}; // provider "off" — cache-only
    }
  } catch (error) {
    console.error("[cellexia] translation provider failed", error);
    translated = {};
  }
  if (claudeUsage.inputTokens > 0 || claudeUsage.outputTokens > 0) {
    await recordSpend(shop, settings.aiModel, claudeUsage, false);
  }

  for (const [reviewId, raw] of Object.entries(translated)) {
    if (!raw || !raw.body) continue;
    // Deterministic dash scrub for every provider (DeepL/Google faithfully
    // reproduce source dashes; Claude is instructed not to but may slip).
    // Scrub before caching so stored rows are clean too.
    const translation = scrubTranslation(raw, target);
    if (!translation) continue;
    result[reviewId] = translation;
    try {
      await prisma.translationCache.upsert({
        where: { reviewId_target: { reviewId, target } },
        update: {
          title: translation.title ?? null,
          body: translation.body,
          reply: translation.reply ?? null,
        },
        create: {
          reviewId,
          target,
          title: translation.title ?? null,
          body: translation.body,
          reply: translation.reply ?? null,
        },
      });
    } catch (error) {
      console.error("[cellexia] translation cache write failed", error);
    }
  }

  return result;
}

/**
 * Applies the em/en-dash scrub to every field of a translation, with the
 * target locale picking the pause mark (、 for ja, ، for ar, ", " otherwise).
 * Returns null when the body scrubs down to nothing (dash-only string) — the
 * caller treats that like a missing translation.
 */
function scrubTranslation(
  translation: ReviewTranslation,
  target: string,
): ReviewTranslation | null {
  const body = scrubDashes(translation.body, target);
  if (!body) return null;
  const title = translation.title ? scrubDashes(translation.title, target) || null : null;
  const reply = translation.reply ? scrubDashes(translation.reply, target) || null : null;
  return { title, body, reply };
}

/* ------------------------------------------------------------------------- *
 * Provider: Anthropic (Claude)
 * ------------------------------------------------------------------------- */

const TRANSLATE_SYSTEM_PROMPT = `You are a professional translator for a premium skincare brand's customer reviews.

You receive a target locale and a JSON array of reviews: [{ "id": string, "title": string|null, "body": string, "reply": string|null }].

Respond with a single JSON object and NOTHING else:
{ "translations": { "<id>": { "title": string|null, "body": string, "reply": string|null } } }

Rules:
- Translate "title", "body" and "reply" into the target locale, preserving each reviewer's meaning, tone and level of formality. Keep null values null. Do not add, remove or reorder reviews, and do not add commentary.
- Write the way a real shopper in that language would write a review: everyday words, natural spoken rhythm. Keep the reviewer's quirks, slang and small imperfections whenever the target language can carry them. Never polish, formalize or embellish the text; a rough casual review must stay rough and casual.
- Never use em dashes or en dashes anywhere in the translation, even when the original contains them. Restructure the sentence with commas, periods or parentheses instead. Regular hyphens inside words are fine.
- Avoid wording that sounds machine translated or assistant written in the target language: stiff formal connectors, brochure superlatives, and dictionary words no shopper would actually say. When a plain everyday word and a fancy word both fit, always pick the plain one.`;

async function translateWithAnthropic(
  apiKey: string | null,
  model: string,
  reviews: Review[],
  target: string,
  /** Accumulates BILLED usage so the caller can charge it to the ledger. */
  usage: { inputTokens: number; outputTokens: number },
): Promise<Record<string, ReviewTranslation>> {
  const out: Record<string, ReviewTranslation> = {};
  if (!apiKey) return out;

  for (const batch of chunkReviews(reviews, 5, 12000)) {
    const payload = batch.map((review) => ({
      id: review.id,
      title: review.title,
      body: review.body.slice(0, 5000),
      reply: review.reply,
    }));
    const call = await callClaudeWithUsage(
      apiKey,
      model,
      TRANSLATE_SYSTEM_PROMPT,
      `Target locale: "${target}"\n\nReviews:\n${JSON.stringify(payload)}`,
      6000,
      // Translation is a mechanical task with a strict JSON contract —
      // thinking adds billed output and can eat the max_tokens budget on
      // models where it is on by default.
      { thinking: thinkingParamFor(model) },
    );
    // Tokens are billed whether or not the text came back usable, so they are
    // added to the ledger before anything else can `continue` past them.
    if (call.ok) {
      usage.inputTokens += call.usage.inputTokens;
      usage.outputTokens += call.usage.outputTokens;
    }
    const raw = call.ok ? call.text : "";
    if (!raw) continue;

    const parsed = extractJson(raw) as { translations?: unknown } | null;
    const translations =
      parsed && typeof parsed === "object" && parsed.translations && typeof parsed.translations === "object"
        ? (parsed.translations as Record<string, unknown>)
        : null;
    if (!translations) continue;

    for (const review of batch) {
      const entry = translations[review.id];
      if (!entry || typeof entry !== "object") continue;
      const t = entry as Record<string, unknown>;
      const body = typeof t.body === "string" && t.body.trim() ? t.body.trim() : null;
      if (!body) continue;
      out[review.id] = {
        title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : null,
        body,
        reply: typeof t.reply === "string" && t.reply.trim() ? t.reply.trim() : null,
      };
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * Provider: DeepL
 * ------------------------------------------------------------------------- */

function deeplTarget(locale: string): string {
  const map: Record<string, string> = { en: "EN-US", "pt-PT": "PT-PT", nb: "NB" };
  return map[locale] ?? locale.toUpperCase();
}

async function translateWithDeepl(
  apiKey: string | null,
  reviews: Review[],
  target: string,
): Promise<Record<string, ReviewTranslation>> {
  if (!apiKey) return {};
  const segments = collectSegments(reviews);
  const translatedTexts: (string | null)[] = new Array(segments.length).fill(null);

  // DeepL accepts up to 50 text params per request — chunk conservatively.
  for (let offset = 0; offset < segments.length; offset += 45) {
    const chunk = segments.slice(offset, offset + 45);
    const texts = await deeplRequest(
      apiKey,
      chunk.map((segment) => segment.text),
      deeplTarget(target),
    );
    if (!texts) continue;
    for (let i = 0; i < chunk.length; i += 1) {
      translatedTexts[offset + i] = texts[i] ?? null;
    }
  }

  return assembleFromSegments(reviews, segments, translatedTexts);
}

async function deeplRequest(
  apiKey: string,
  texts: string[],
  targetLang: string,
): Promise<string[] | null> {
  const key = apiKey.trim();
  // Free-tier keys end with ":fx" and live on api-free.deepl.com; keep the
  // other host as a fallback in case the key type was misdetected.
  const hosts = key.endsWith(":fx")
    ? ["https://api-free.deepl.com", "https://api.deepl.com"]
    : ["https://api.deepl.com", "https://api-free.deepl.com"];

  for (const host of hosts) {
    try {
      const body = new URLSearchParams();
      for (const text of texts) body.append("text", text);
      body.set("target_lang", targetLang);

      const response = await fetch(`${host}/v2/translate`, {
        method: "POST",
        headers: {
          Authorization: `DeepL-Auth-Key ${key}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (response.status === 401 || response.status === 403) {
        continue; // wrong host for this key type — try the other one
      }
      if (!response.ok) {
        console.error(`[cellexia] DeepL error ${response.status} at ${host}`);
        return null;
      }

      const json = (await response.json()) as {
        translations?: Array<{ text?: string }>;
      };
      const translations = json.translations;
      if (!Array.isArray(translations) || translations.length !== texts.length) return null;
      return translations.map((t) => String(t?.text ?? ""));
    } catch (error) {
      console.error(`[cellexia] DeepL request failed at ${host}`, error);
    }
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * Provider: Google Cloud Translation v2
 * ------------------------------------------------------------------------- */

function googleTarget(locale: string): string {
  const map: Record<string, string> = { "pt-PT": "pt", nb: "no" };
  return map[locale] ?? locale;
}

async function translateWithGoogle(
  apiKey: string | null,
  reviews: Review[],
  target: string,
): Promise<Record<string, ReviewTranslation>> {
  if (!apiKey) return {};
  const segments = collectSegments(reviews);
  const translatedTexts: (string | null)[] = new Array(segments.length).fill(null);

  for (let offset = 0; offset < segments.length; offset += 100) {
    const chunk = segments.slice(offset, offset + 100);
    try {
      const response = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey.trim())}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            q: chunk.map((segment) => segment.text),
            target: googleTarget(target),
            format: "text",
          }),
        },
      );
      if (!response.ok) {
        console.error(`[cellexia] Google Translate error ${response.status}`);
        continue;
      }
      const json = (await response.json()) as {
        data?: { translations?: Array<{ translatedText?: string }> };
      };
      const translations = json.data?.translations;
      if (!Array.isArray(translations) || translations.length !== chunk.length) continue;
      for (let i = 0; i < chunk.length; i += 1) {
        translatedTexts[offset + i] = String(translations[i]?.translatedText ?? "");
      }
    } catch (error) {
      console.error("[cellexia] Google Translate request failed", error);
    }
  }

  return assembleFromSegments(reviews, segments, translatedTexts);
}

/* ------------------------------------------------------------------------- *
 * Segment plumbing shared by DeepL/Google
 * ------------------------------------------------------------------------- */

interface Segment {
  reviewId: string;
  field: "title" | "body" | "reply";
  text: string;
}

function collectSegments(reviews: Review[]): Segment[] {
  const segments: Segment[] = [];
  for (const review of reviews) {
    if (review.title && review.title.trim()) {
      segments.push({ reviewId: review.id, field: "title", text: review.title });
    }
    segments.push({ reviewId: review.id, field: "body", text: review.body.slice(0, 5000) });
    if (review.reply && review.reply.trim()) {
      segments.push({ reviewId: review.id, field: "reply", text: review.reply });
    }
  }
  return segments;
}

function assembleFromSegments(
  reviews: Review[],
  segments: Segment[],
  translatedTexts: (string | null)[],
): Record<string, ReviewTranslation> {
  const byReview = new Map<string, { title: string | null; body: string | null; reply: string | null }>();
  for (const review of reviews) {
    byReview.set(review.id, { title: null, body: null, reply: null });
  }
  for (let i = 0; i < segments.length; i += 1) {
    const text = translatedTexts[i];
    if (text === null || text === "") continue;
    const entry = byReview.get(segments[i].reviewId);
    if (entry) entry[segments[i].field] = text;
  }

  const out: Record<string, ReviewTranslation> = {};
  for (const [reviewId, entry] of byReview) {
    if (!entry.body) continue; // body is mandatory — drop incomplete results
    out[reviewId] = { title: entry.title, body: entry.body, reply: entry.reply };
  }
  return out;
}

/** Batches reviews for the Claude provider by count and cumulative body size. */
function chunkReviews(reviews: Review[], maxItems: number, maxChars: number): Review[][] {
  const batches: Review[][] = [];
  let current: Review[] = [];
  let currentChars = 0;
  for (const review of reviews) {
    const size = review.body.length + (review.title?.length ?? 0) + (review.reply?.length ?? 0);
    if (current.length > 0 && (current.length >= maxItems || currentChars + size > maxChars)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(review);
    currentChars += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
