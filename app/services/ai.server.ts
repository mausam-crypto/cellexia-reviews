/**
 * Cellexia Reviews — AI summary service (Claude Messages API).
 *
 * `generateSummary` performs the full generation for a product in the shop's
 * default locale: it collects up to 200 of the most recent PUBLISHED reviews,
 * makes exactly one Claude Messages API call with a fixed system prompt, parses
 * the strict-JSON topic contract (§7 of SPEC), stores the result in the
 * `Summary` table and returns a `SummaryDTO`.
 *
 * `localizeSummary` never generates from scratch — it translates an existing
 * summary (text + topic labels + blurbs only) into the target locale and caches
 * the localized row.
 *
 * `countTokens` (SPEC-1.7 §4) prices a prospective prompt via the Anthropic
 * token-counting endpoint (`POST /v1/messages/count_tokens`) using the exact
 * same auth headers and retry conventions as `callClaude`; it is consumed by
 * estimate.server.ts and returns `null` on any failure.
 *
 * All failures — missing API key, provider turned off, network errors,
 * unparseable model output — degrade gracefully by returning `null`. Nothing in
 * this module throws to a route.
 */
import prisma from "~/db.server";
import { SHOP_LOCALES } from "~/types/cellexia";
import type { SummaryDTO, TopicDTO } from "~/types/cellexia";
import { getSettings } from "./settings.server";
import { scrubDashes } from "./synthetic-prompts.server";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_COUNT_TOKENS_URL = "https://api.anthropic.com/v1/messages/count_tokens";
const ANTHROPIC_VERSION = "2023-06-01";

/** Topic shape as persisted inside Summary.topics (JSON string column). */
export interface StoredTopic {
  key: string;
  label: string;
  count: number;
  pos: number;
  neg: number;
  sentiment: "positive" | "negative" | "mixed";
  blurb: string;
  terms: string[];
  reviewIds: string[];
}

const SENTIMENTS = ["positive", "negative", "mixed"] as const;

/* ------------------------------------------------------------------------- *
 * Shared helpers (also used by reviews.server.ts and translate.server.ts)
 * ------------------------------------------------------------------------- */

/** Parses the JSON topics column defensively; malformed data yields []. */
export function parseStoredTopics(raw: string | null | undefined): StoredTopic[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const topics: StoredTopic[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;
    if (typeof t.key !== "string" || t.key.length === 0) continue;
    topics.push({
      key: t.key,
      label: typeof t.label === "string" ? t.label : t.key,
      count: toCount(t.count),
      pos: toCount(t.pos),
      neg: toCount(t.neg),
      sentiment: isSentiment(t.sentiment) ? t.sentiment : "positive",
      blurb: typeof t.blurb === "string" ? t.blurb : "",
      terms: toStringArray(t.terms),
      reviewIds: toStringArray(t.reviewIds),
    });
  }
  return topics;
}

/** Public DTO mapping — strips `reviewIds` (server-side filtering data only). */
/** Stored Summary.suggestedQuestions JSON → string[] (defensive). */
export function parseStoredQuestions(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((q): q is string => typeof q === "string" && q.length > 0).slice(0, 6)
      : [];
  } catch {
    return [];
  }
}

export function topicsToDTO(topics: StoredTopic[]): TopicDTO[] {
  return topics.map((t) => ({
    key: t.key,
    label: t.label,
    count: t.count,
    pos: t.pos,
    neg: t.neg,
    sentiment: t.sentiment,
    blurb: t.blurb,
    terms: t.terms,
  })) as TopicDTO[];
}

/**
 * Robustly extracts a JSON object from model output: tries fenced blocks first,
 * then the widest `{...}` span. Returns null when nothing parses.
 */
export function extractJson(text: string): unknown {
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) candidates.push(fence[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

/**
 * One Claude Messages API call via fetch. Returns the concatenated text blocks
 * or null on any failure. Retries once on transient statuses (429/5xx/529).
 */
export async function callClaude(
  apiKey: string,
  model: string,
  system: string,
  userContent: string,
  maxTokens = 3000,
): Promise<string | null> {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });

      if (response.status === 429 || response.status >= 500) {
        // Transient — back off briefly and retry once.
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
        console.error(`[cellexia] Claude API transient error ${response.status}`);
        return null;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(
          `[cellexia] Claude API error ${response.status}: ${detail.slice(0, 300)}`,
        );
        return null;
      }

      const data = (await response.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        stop_reason?: string;
      };
      if (data.stop_reason === "refusal") return null;
      if (data.stop_reason === "max_tokens") {
        console.error("[cellexia] Claude response truncated at max_tokens — output likely unparseable");
      }
      const text = Array.isArray(data.content)
        ? data.content
            .filter((block) => block && block.type === "text" && typeof block.text === "string")
            .map((block) => block.text as string)
            .join("\n")
        : "";
      return text.length > 0 ? text : null;
    } catch (error) {
      if (attempt === 0) {
        await sleep(1000);
        continue;
      }
      console.error("[cellexia] Claude API request failed", error);
      return null;
    }
  }
  return null;
}

/**
 * Exact input-token count for a prospective Messages API call, via the
 * Anthropic token-counting endpoint (`POST /v1/messages/count_tokens`,
 * SPEC-1.7 §4). Counting is free and model-specific — pass the same model the
 * generation call would use. Same auth/headers/retry conventions as
 * `callClaude`: retries once on transient statuses (429/5xx/529) and network
 * errors, and returns null on any failure instead of throwing.
 */
export async function countTokens(
  apiKey: string,
  model: string,
  system: string,
  userContent: string,
): Promise<number | null> {
  const body = JSON.stringify({
    model,
    system,
    messages: [{ role: "user", content: userContent }],
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });

      if (response.status === 429 || response.status >= 500) {
        // Transient — back off briefly and retry once.
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
        console.error(`[cellexia] Claude count_tokens transient error ${response.status}`);
        return null;
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error(
          `[cellexia] Claude count_tokens error ${response.status}: ${detail.slice(0, 300)}`,
        );
        return null;
      }

      const data = (await response.json()) as { input_tokens?: unknown };
      const tokens = Number(data.input_tokens);
      return Number.isFinite(tokens) && tokens >= 0 ? Math.round(tokens) : null;
    } catch (error) {
      if (attempt === 0) {
        await sleep(1000);
        continue;
      }
      console.error("[cellexia] Claude count_tokens request failed", error);
      return null;
    }
  }
  return null;
}

/**
 * Live verification of an Anthropic API key + model pair, for the Settings
 * page "Test key" button. Uses the free count_tokens endpoint (no tokens are
 * billed) and, unlike countTokens above, distinguishes WHY a call failed so
 * the merchant gets an actionable message instead of a silent null:
 *   - ok            : key accepted, model reachable
 *   - invalid_key   : 401 — wrong/revoked key
 *   - forbidden     : 403 — key valid but not permitted for this API
 *   - model_missing : 404 — key valid, model id not available on this account
 *   - error         : anything else (transient statuses retried once first)
 */
export type KeyVerification =
  | { status: "ok" }
  | { status: "invalid_key" | "forbidden" | "model_missing" }
  | { status: "error"; detail: string };

export async function verifyAnthropicKey(
  apiKey: string,
  model: string,
): Promise<KeyVerification> {
  const body = JSON.stringify({
    model,
    system: "ping",
    messages: [{ role: "user", content: "ping" }],
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      });
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 0) {
          await sleep(1500);
          continue;
        }
        return { status: "error", detail: `Anthropic answered ${response.status} (transient) — try again in a minute` };
      }
      if (response.status === 401) return { status: "invalid_key" };
      if (response.status === 403) return { status: "forbidden" };
      if (response.status === 404) return { status: "model_missing" };
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        return { status: "error", detail: `Anthropic answered ${response.status}: ${detail.slice(0, 120)}` };
      }
      return { status: "ok" };
    } catch (error) {
      if (attempt === 0) {
        await sleep(1000);
        continue;
      }
      return { status: "error", detail: "Could not reach the Anthropic API (network error)" };
    }
  }
  return { status: "error", detail: "Could not reach the Anthropic API" };
}

/* ------------------------------------------------------------------------- *
 * Summary generation
 * ------------------------------------------------------------------------- */

const GENERATION_SYSTEM_PROMPT = `You are the review-analysis engine for Cellexia, a premium anti-aging skincare brand. You produce a "Customers say" summary from customer product reviews, in the style of Amazon's AI review highlights.

Respond with a single JSON object and NOTHING else — no markdown fences, no commentary before or after. Schema:
{
  "text": string,       // 2-4 sentences summarising overall customer sentiment, written in the requested locale. Mention what customers praise AND any recurring criticism.
  "topics": [           // at most 8 items, ordered by count descending
    {
      "key": string,        // stable lowercase slug, [a-z0-9_] only, e.g. "moisturizing"
      "label": string,      // short human label in the requested locale, e.g. "Moisturizing"
      "count": number,      // number of provided reviews mentioning the topic
      "pos": number,        // of those, how many mention it positively
      "neg": number,        // of those, how many mention it negatively
      "sentiment": "positive" | "negative" | "mixed",
      "blurb": string,      // one sentence, e.g. "Customers love how moisturizing the cream feels."
      "terms": [string],    // 1-5 lowercase substrings/stems that appear in the review texts, for client-side highlighting, e.g. ["moistur", "hydrat"]
      "reviewIds": [string] // ids of AT MOST 25 of the provided reviews that best represent this topic (never list more than 25)
    }
  ]
}

The object also contains:
  "questions": [string]  // 4-5 short questions (each under 70 characters, in the requested locale) a shopper might ask that the provided reviews can actually answer, e.g. "Does it absorb quickly?". Phrase them the way a shopper would type them.

Hard rules:
- Only include topics mentioned by at least 3 of the provided reviews.
- "count" must never exceed the number of provided reviews; pos + neg must never exceed count.
- Every id in "reviewIds" must be one of the provided review ids.
- "terms" must be lowercase substrings actually found in the review texts.
- Do not invent quotes, statistics or topics not supported by the reviews.
- Every question must be answerable from the provided reviews alone.
- Never use em dashes or en dashes anywhere. Use commas, periods, or parentheses instead.`;

const LOCALIZE_SYSTEM_PROMPT = `You are a professional translator for Cellexia, a premium anti-aging skincare brand. You receive a JSON object describing a customer-review summary and a target locale.

Respond with a single JSON object and NOTHING else:
{ "text": string, "topics": [{ "key": string, "label": string, "blurb": string }], "questions": [string] }

Translate "text", every "label", every "blurb" and every entry of "questions" into the target locale using a warm, premium, formal register (vouvoiement / Sie / usted / Lei / u; Japanese: desu/masu). Keep every "key" EXACTLY unchanged, keep the topics array in the same order with the same length, and keep "questions" in the same order with the same length. Do not translate the keys, do not add or remove items, do not add commentary. Never use em dashes or en dashes.`;

/**
 * Full summary generation in the given (default) locale.
 * Returns null when AI is disabled, unconfigured, or generation fails.
 */
export async function generateSummary(
  shop: string,
  productId: string,
  locale: string,
): Promise<SummaryDTO | null> {
  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return null;

  const targetLocale = (SHOP_LOCALES as readonly string[]).includes(locale) ? locale : "en";

  const reviews = await prisma.review.findMany({
    where: { shop, productId: String(productId), status: "PUBLISHED" },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      rating: true,
      title: true,
      body: true,
      language: true,
      productTitle: true,
    },
  });
  if (reviews.length === 0) return null;

  const productTitle = reviews.find((r) => r.productTitle)?.productTitle ?? `Product ${productId}`;
  const lines = reviews
    .map((r) =>
      JSON.stringify({
        id: r.id,
        rating: r.rating,
        language: r.language,
        title: r.title ?? undefined,
        body: r.body.slice(0, 600),
      }),
    )
    .join("\n");
  const userContent = `Product: ${productTitle}\nTarget locale for "text", "label" and "blurb": "${targetLocale}"\nNumber of reviews provided: ${reviews.length}\n\nReviews (one JSON object per line):\n${lines}`;

  const raw = await callClaude(
    settings.anthropicApiKey,
    settings.aiModel,
    GENERATION_SYSTEM_PROMPT,
    userContent,
    8000, // review fix: the topics JSON overflowed 4000 and truncated-JSON
          // parses failed AFTER the tokens were billed
  );
  if (!raw) return null;

  const parsed = extractJson(raw) as { text?: unknown; topics?: unknown; questions?: unknown } | null;
  if (!parsed || typeof parsed.text !== "string" || parsed.text.trim().length === 0) {
    console.error("[cellexia] AI summary: could not parse model output");
    return null;
  }

  const validIds = new Set(reviews.map((r) => r.id));
  const topics = sanitizeTopics(parsed.topics, validIds, reviews.length);
  const text = scrubDashes(parsed.text.trim(), targetLocale);
  const questions = sanitizeQuestions(parsed.questions, targetLocale);

  try {
    await prisma.summary.upsert({
      where: { shop_productId_locale: { shop, productId: String(productId), locale: targetLocale } },
      update: {
        text,
        topics: JSON.stringify(topics),
        suggestedQuestions: JSON.stringify(questions),
        reviewCount: reviews.length,
        model: settings.aiModel,
      },
      create: {
        shop,
        productId: String(productId),
        locale: targetLocale,
        text,
        topics: JSON.stringify(topics),
        suggestedQuestions: JSON.stringify(questions),
        reviewCount: reviews.length,
        model: settings.aiModel,
      },
    });
    // A fresh default-locale summary invalidates cached localizations; they
    // will be regenerated on demand by localizeSummary (§6 summary endpoint).
    await prisma.summary.deleteMany({
      where: { shop, productId: String(productId), NOT: { locale: targetLocale } },
    });
  } catch (error) {
    console.error("[cellexia] AI summary: failed to persist", error);
    return null;
  }

  return { locale: targetLocale, text, topics: topicsToDTO(topics), questions } as SummaryDTO;
}

/**
 * v1.16 (SPEC-1.16 §3): whitelist the generated shopper questions — strings
 * only, trimmed, dash-scrubbed, ≤ 80 chars each, at most 6.
 */
export function sanitizeQuestions(value: unknown, locale?: string): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const q = scrubDashes(item.trim(), locale).slice(0, 80);
    if (q.length >= 3 && !out.includes(q)) out.push(q);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * v1.16 (SPEC-1.16 §1) — lazy first generation. A store whose reviews were
 * imported before an API key existed has no Summary rows and, pre-1.16,
 * no path that would ever create one from storefront traffic. When the
 * summary endpoint finds nothing, it calls this: fire-and-forget, one
 * attempt per shop+product per 10 minutes, generating the DEFAULT-locale
 * summary in the background (the "en" convention the admin regenerate path
 * uses) so the next visit serves it. Never blocks or throws to the route.
 * Product metafields are NOT synced here (no Admin client on the proxy
 * path) — the widget reads the summary via the API, and the metafield
 * catches up on the next admin-side sync.
 */
const firstGenAttempts = new Map<string, { nextAt: number; failures: number }>();
const FIRST_GEN_DEBOUNCE_MS = 10 * 60 * 1000;
// Review hardening: anonymous traffic must never turn into unbounded spend.
const LAZY_GEN_DAILY_CAP = 50; // fresh generation ATTEMPTS per shop per day
const LAZY_GEN_MAX_INFLIGHT = 2;
let lazyGenInFlight = 0;
const lazyGenDaily = new Map<string, { day: string; count: number }>();

function lazyGenBudgetOk(shop: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const entry = lazyGenDaily.get(shop);
  if (!entry || entry.day !== day) {
    lazyGenDaily.set(shop, { day, count: 1 });
    if (lazyGenDaily.size > 500) lazyGenDaily.clear();
    return true;
  }
  if (entry.count >= LAZY_GEN_DAILY_CAP) return false;
  entry.count += 1;
  return true;
}

export function maybeScheduleFirstGeneration(shop: string, productId: string): void {
  const key = `${shop}|${productId}`;
  const now = Date.now();
  const state = firstGenAttempts.get(key);
  if (state && state.nextAt > now) return;
  if (firstGenAttempts.size > 2000) {
    // Evict only EXPIRED entries — a wholesale clear() would reset every
    // product's backoff floor at once (review fix). Still full ⇒ fail closed
    // (skip scheduling; no spend).
    for (const [k, v] of firstGenAttempts) {
      if (v.nextAt <= now) firstGenAttempts.delete(k);
    }
    if (firstGenAttempts.size > 2000) return;
  }
  if (lazyGenInFlight >= LAZY_GEN_MAX_INFLIGHT) return;
  if (!lazyGenBudgetOk(shop)) return;
  // Exponential backoff on repeated failures: 10 min → 1 h → 6 h → 24 h.
  const failures = state?.failures ?? 0;
  const backoff = [FIRST_GEN_DEBOUNCE_MS, 3600_000, 6 * 3600_000, 24 * 3600_000][
    Math.min(failures, 3)
  ];
  firstGenAttempts.set(key, { nextAt: now + backoff, failures });
  lazyGenInFlight += 1;
  void (async () => {
    try {
      const existing = await prisma.summary.findFirst({
        where: { shop, productId: String(productId) },
        select: { id: true },
      });
      if (existing) return;
      const published = await prisma.review.count({
        where: { shop, productId: String(productId), status: "PUBLISHED" },
      });
      if (published === 0) return;
      const settings = await getSettings(shop);
      if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey || !settings.showSummary) {
        return;
      }
      const result = await generateSummary(shop, String(productId), "en");
      const st = firstGenAttempts.get(key);
      if (st) {
        if (result) {
          st.failures = 0; // success: the `existing` check gates future runs
        } else {
          st.failures += 1;
          const b = [FIRST_GEN_DEBOUNCE_MS, 3600_000, 6 * 3600_000, 24 * 3600_000][
            Math.min(st.failures, 3)
          ];
          st.nextAt = Date.now() + b;
        }
      }
    } catch (error) {
      console.error("[cellexia] lazy summary generation failed", error);
      const st = firstGenAttempts.get(key);
      if (st) { st.failures += 1; st.nextAt = Date.now() + 3600_000; }
    } finally {
      lazyGenInFlight = Math.max(0, lazyGenInFlight - 1);
    }
  })();
}

/**
 * Returns the summary in `targetLocale`, translating the existing
 * default-locale summary on demand and caching the result. Never generates a
 * summary from scratch. Returns null when there is nothing to localize or the
 * AI provider is unavailable.
 */
export async function localizeSummary(
  shop: string,
  productId: string,
  targetLocale: string,
): Promise<SummaryDTO | null> {
  if (!(SHOP_LOCALES as readonly string[]).includes(targetLocale)) return null;
  const pid = String(productId);

  const existing = await prisma.summary.findUnique({
    where: { shop_productId_locale: { shop, productId: pid, locale: targetLocale } },
  });
  if (existing) {
    return {
      locale: existing.locale,
      text: existing.text,
      topics: topicsToDTO(parseStoredTopics(existing.topics)),
      questions: parseStoredQuestions(existing.suggestedQuestions),
    } as SummaryDTO;
  }

  const source = await prisma.summary.findFirst({
    where: { shop, productId: pid, NOT: { locale: targetLocale } },
    orderBy: { updatedAt: "desc" },
  });
  if (!source) return null;

  const settings = await getSettings(shop);
  if (settings.aiProvider !== "anthropic" || !settings.anthropicApiKey) return null;

  const sourceTopics = parseStoredTopics(source.topics);
  const sourceQuestions = parseStoredQuestions(source.suggestedQuestions);
  const payload = {
    text: source.text,
    topics: sourceTopics.map((t) => ({ key: t.key, label: t.label, blurb: t.blurb })),
    questions: sourceQuestions,
  };
  const raw = await callClaude(
    settings.anthropicApiKey,
    settings.aiModel,
    LOCALIZE_SYSTEM_PROMPT,
    `Target locale: "${targetLocale}"\n\n${JSON.stringify(payload)}`,
    3000,
  );
  if (!raw) return null;

  const parsed = extractJson(raw) as
    | { text?: unknown; topics?: unknown; questions?: unknown }
    | null;
  if (!parsed || typeof parsed.text !== "string" || parsed.text.trim().length === 0) return null;
  const localizedQuestions = sanitizeQuestions(parsed.questions, targetLocale);
  // Review fix: on a count mismatch, store NO questions for this locale (the
  // widget hides the pills) — never permanently cache source-language pills.
  const questions =
    localizedQuestions.length === sourceQuestions.length && sourceQuestions.length > 0
      ? localizedQuestions
      : [];

  const translatedByKey = new Map<string, { label?: string; blurb?: string }>();
  if (Array.isArray(parsed.topics)) {
    for (const entry of parsed.topics) {
      if (!entry || typeof entry !== "object") continue;
      const t = entry as Record<string, unknown>;
      if (typeof t.key !== "string") continue;
      translatedByKey.set(t.key, {
        label: typeof t.label === "string" ? t.label : undefined,
        blurb: typeof t.blurb === "string" ? t.blurb : undefined,
      });
    }
  }

  const mergedTopics: StoredTopic[] = sourceTopics.map((t) => {
    const translated = translatedByKey.get(t.key);
    return {
      ...t,
      label: translated?.label ?? t.label,
      blurb: translated?.blurb ?? t.blurb,
    };
  });
  const text = scrubDashes(parsed.text.trim(), targetLocale);

  try {
    await prisma.summary.upsert({
      where: { shop_productId_locale: { shop, productId: pid, locale: targetLocale } },
      update: {
        text,
        topics: JSON.stringify(mergedTopics),
        suggestedQuestions: JSON.stringify(questions),
        reviewCount: source.reviewCount,
        model: source.model,
      },
      create: {
        shop,
        productId: pid,
        locale: targetLocale,
        text,
        topics: JSON.stringify(mergedTopics),
        suggestedQuestions: JSON.stringify(questions),
        reviewCount: source.reviewCount,
        model: source.model,
      },
    });
  } catch (error) {
    console.error("[cellexia] AI summary localization: failed to persist", error);
    // Still return the translated content — caching is best-effort.
  }

  return { locale: targetLocale, text, topics: topicsToDTO(mergedTopics), questions } as SummaryDTO;
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

function sanitizeTopics(
  rawTopics: unknown,
  validIds: Set<string>,
  reviewCount: number,
): StoredTopic[] {
  if (!Array.isArray(rawTopics)) return [];
  const seenKeys = new Set<string>();
  const topics: StoredTopic[] = [];

  for (const entry of rawTopics) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as Record<string, unknown>;

    const key = String(t.key ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60);
    if (!key || seenKeys.has(key)) continue;

    const label = typeof t.label === "string" && t.label.trim() ? t.label.trim().slice(0, 80) : null;
    if (!label) continue;

    let count = Math.min(toCount(t.count), reviewCount);
    let pos = Math.min(toCount(t.pos), count);
    let neg = Math.min(toCount(t.neg), Math.max(0, count - pos));
    if (count === 0) count = pos + neg;
    if (count < 3) continue; // each topic must be mentioned by >= 3 reviews

    const sentiment = isSentiment(t.sentiment)
      ? t.sentiment
      : neg > pos
        ? pos > 0
          ? "mixed"
          : "negative"
        : "positive";

    const terms = toStringArray(t.terms)
      .map((term) => term.toLowerCase().trim())
      .filter((term) => term.length >= 2)
      .slice(0, 6);

    const reviewIds = toStringArray(t.reviewIds)
      .filter((id) => validIds.has(id))
      .slice(0, 25); // review fix: matches the prompt cap; 200 ids per topic
                     // is what overflowed max_tokens

    seenKeys.add(key);
    topics.push({
      key,
      label,
      count,
      pos,
      neg,
      sentiment,
      blurb: typeof t.blurb === "string" ? t.blurb.trim().slice(0, 400) : "",
      terms,
      reviewIds,
    });
    if (topics.length >= 8) break; // max 8 topics
  }

  topics.sort((a, b) => b.count - a.count);
  return topics;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function isSentiment(value: unknown): value is StoredTopic["sentiment"] {
  return typeof value === "string" && (SENTIMENTS as readonly string[]).includes(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
