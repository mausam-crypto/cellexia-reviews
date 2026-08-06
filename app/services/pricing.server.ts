/**
 * Cellexia Reviews — Anthropic price table and cost math (SPEC-1.20 §2).
 *
 * Prices are Anthropic's published list prices in USD per MILLION tokens, as
 * of 2026-08-03. They are used for two things only: the pre-run estimate the
 * merchant approves, and the spend counter that enforces their ceiling.
 *
 * An unknown model id yields `null` rather than a guess — every caller must
 * degrade to showing token counts without a dollar figure. Silently pricing
 * an unknown model at a neighbour's rate would put a wrong number in front of
 * a merchant deciding whether to spend money.
 */

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
  /**
   * Optional promotional rate that applies up to and including `until`
   * (YYYY-MM-DD, UTC). After that date the standard rate above applies.
   */
  intro?: { inputPerMTok: number; outputPerMTok: number; until: string };
}

/** Anthropic list prices, checked 2026-08-03. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-fable-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-mythos-5": { inputPerMTok: 10, outputPerMTok: 50 },
  "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-8": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-7": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-opus-4-6": { inputPerMTok: 5, outputPerMTok: 25 },
  "claude-sonnet-5": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    intro: { inputPerMTok: 2, outputPerMTok: 10, until: "2026-08-31" },
  },
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Model facts the curation payload builder needs (verified against the docs
 * 2026-08-05, same source as the prices):
 * - contextWindowTokens: what one request may actually carry. Haiku 4.5 is
 *   200k, NOT 1M — a payload budget assuming 1M hands Haiku a request the API
 *   rejects outright.
 * - thinkingOnByDefault: on Sonnet 5 / Opus 5 / Fable 5 the model THINKS
 *   before answering unless told not to, and the thinking is billed as output
 *   and counts against max_tokens. A structured-JSON call with a small
 *   max_tokens must disable it, or a big task spends the whole budget
 *   thinking and the JSON never arrives (stop_reason "max_tokens").
 */
const MODEL_FACTS: Record<string, { contextWindowTokens: number; thinkingOnByDefault: boolean }> = {
  "claude-fable-5": { contextWindowTokens: 1_000_000, thinkingOnByDefault: true },
  "claude-mythos-5": { contextWindowTokens: 1_000_000, thinkingOnByDefault: true },
  "claude-opus-5": { contextWindowTokens: 1_000_000, thinkingOnByDefault: true },
  "claude-opus-4-8": { contextWindowTokens: 1_000_000, thinkingOnByDefault: false },
  "claude-opus-4-7": { contextWindowTokens: 1_000_000, thinkingOnByDefault: false },
  "claude-opus-4-6": { contextWindowTokens: 1_000_000, thinkingOnByDefault: false },
  "claude-sonnet-5": { contextWindowTokens: 1_000_000, thinkingOnByDefault: true },
  "claude-sonnet-4-6": { contextWindowTokens: 1_000_000, thinkingOnByDefault: false },
  "claude-haiku-4-5": { contextWindowTokens: 200_000, thinkingOnByDefault: false },
};

/** Unknown model ⇒ the SMALL window: over-sending gets a request rejected. */
export function contextWindowFor(model: string): number {
  return MODEL_FACTS[model]?.contextWindowTokens ?? 200_000;
}

/**
 * The `thinking` parameter a deterministic JSON call should send, or null to
 * send none. Only models where thinking is on by default accept/need
 * "disabled"; sending it to older models would 400.
 */
export function thinkingParamFor(model: string): { type: "disabled" } | null {
  return MODEL_FACTS[model]?.thinkingOnByDefault ? { type: "disabled" } : null;
}

/** The Message Batches API bills at half the standard rate (SPEC-1.20 §4). */
export const BATCH_DISCOUNT = 0.5;

/** Date the table above was verified — surfaced in the admin estimate. */
export const PRICES_AS_OF = "2026-08-03";

/**
 * Effective per-MTok rates for a model on a given day, honouring any
 * promotional window. `null` when the model is not in the table.
 */
export function ratesFor(
  model: string,
  today: string = new Date().toISOString().slice(0, 10),
): { inputPerMTok: number; outputPerMTok: number; introApplied: boolean } | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  if (price.intro && today <= price.intro.until) {
    return {
      inputPerMTok: price.intro.inputPerMTok,
      outputPerMTok: price.intro.outputPerMTok,
      introApplied: true,
    };
  }
  return {
    inputPerMTok: price.inputPerMTok,
    outputPerMTok: price.outputPerMTok,
    introApplied: false,
  };
}

export interface CostInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Batch API requests bill at 50%. */
  batch?: boolean;
  /** Override "today" for deterministic tests. */
  today?: string;
}

/** USD cost of a call, or null when the model has no published price here. */
export function costUsd({
  model,
  inputTokens,
  outputTokens,
  batch = false,
  today,
}: CostInput): number | null {
  const rates = ratesFor(model, today);
  if (!rates) return null;
  const raw =
    (Math.max(0, inputTokens) / 1_000_000) * rates.inputPerMTok +
    (Math.max(0, outputTokens) / 1_000_000) * rates.outputPerMTok;
  const total = batch ? raw * BATCH_DISCOUNT : raw;
  // Round to a hundredth of a cent: enough precision for a per-call figure,
  // and it keeps float noise out of the stored monthly total.
  return Math.round(total * 10000) / 10000;
}

/** "$12.34" / "$0.0421" — small amounts keep more precision than currency. */
export function formatUsd(value: number): string {
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

/** Latin-script chars per token — deliberately low, so the estimate runs high. */
const ASCII_CHARS_PER_TOKEN = 3.4;

/**
 * Local, zero-cost token approximation used only where an exact count is not
 * worth an API round trip (the payload-trimming ladder in curation.server).
 * Never used for anything the merchant is shown as a cost.
 *
 * A single chars-per-token ratio is not safe here. Latin prose runs about 3.9
 * chars per token, but Japanese, Chinese, Arabic, Greek and Cyrillic run close
 * to ONE character per token — a whole-catalogue Japanese payload judged at
 * 3.4 would be counted at a third of its real size and could overflow the
 * context window the ladder exists to protect. Non-ASCII characters are
 * therefore counted as a full token each, which over-estimates (accents in
 * French, say, are cheap) in the safe direction: the ladder trims early rather
 * than sending a call that cannot fit.
 */
export function approxTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) < 0x80) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + wide);
}

/**
 * Same estimate from a character COUNT alone, for text too large to
 * materialize. Assumes Latin script, so it is the LOW bound — only use it
 * where the figure is presented as an estimate, never to gate context size.
 */
export function approxTokensForChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / ASCII_CHARS_PER_TOKEN);
}
