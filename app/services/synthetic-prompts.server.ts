/**
 * Persona/style briefs for the synthetic review generator (SPEC-1.4 §C).
 *
 * Each brief is a self-contained writing instruction for ONE review. The
 * generator rotates through these (shuffled per batch) so a batch reads like
 * dozens of different humans wrote it. Briefs are product-agnostic — product
 * facts (title, description, variants, usage) are injected separately by
 * synthetic.server.ts, and the assigned star rating always outranks the
 * persona: a 2-star review from an enthusiastic persona reads as let-down
 * enthusiasm, not as praise.
 *
 * v1.10 (SPEC-1.10 §4): every string handed to the model (briefs, tones,
 * quirks) is written WITHOUT em (—) or en (–) dashes, so the prompts never
 * exemplify the character real shoppers rarely type. STYLE_RULES (below) is
 * appended to the chunk generation prompt, and scrubDashes (below) is the
 * deterministic last-resort sanitizer applied to every parsed title/body/
 * reply. Regular hyphens (-) are fine everywhere.
 */

export type LengthBand = "one_liner" | "short" | "medium" | "long";

export interface PersonaBrief {
  key: string;
  /** Writing instruction handed to the model for this review. */
  brief: string;
  tone: string;
  length: LengthBand;
  /** Occasional humanizing quirks the model may apply sparingly. */
  quirks?: string;
}

/**
 * Target share of length bands across a batch (synthetic.server.ts samples
 * personas until the realized mix roughly matches).
 */
export const LENGTH_MIX: Record<LengthBand, number> = {
  one_liner: 0.15,
  short: 0.4,
  medium: 0.35,
  long: 0.1,
};

export const PERSONA_BRIEFS: readonly PersonaBrief[] = [
  {
    key: "skeptic_converted",
    brief:
      "A shopper who almost didn't buy because they've been burned by skincare marketing before. Open with the doubt, pivot to what changed their mind after real use. Mention one concrete observable result.",
    tone: "wry, honest",
    length: "medium",
  },
  {
    key: "ingredient_nerd",
    brief:
      "A reader of ingredient lists who knows their actives. Reference the kind of ingredients this product plausibly contains (from the product description only, never invent specific percentages). Judge the formula like a knowledgeable amateur, not a chemist.",
    tone: "analytical, precise",
    length: "medium",
  },
  {
    key: "gift_buyer",
    brief:
      "Bought it as a gift (mother, sister, friend). They report the recipient's reaction second-hand and their own impression of packaging and presentation.",
    tone: "warm, slightly detached",
    length: "short",
  },
  {
    key: "minimalist_two_liner",
    brief: "Two sentences maximum. States what it does for them and whether they'd rebuy. No fluff.",
    tone: "clipped, decisive",
    length: "one_liner",
  },
  {
    key: "routine_storyteller",
    brief:
      "Describes exactly where the product sits in their morning or evening routine (what comes before and after) and how it layers. The routine details make it credible.",
    tone: "chatty, methodical",
    length: "long",
  },
  {
    key: "long_term_repurchaser",
    brief:
      "On their second or third jar/bottle. Compares how their skin was before they started months ago versus now. Mentions rebuying without being asked.",
    tone: "settled, loyal",
    length: "medium",
  },
  {
    key: "price_sensitive_convert",
    brief:
      "Hesitated over the price, decided to try it, and now weighs cost against results honestly. If the rating is high they conclude it's worth it; if low, the price stings extra.",
    tone: "practical, budget-aware",
    length: "medium",
  },
  {
    key: "sensitive_skin_cautious",
    brief:
      "Has reactive skin and patch-tested first. Reports on irritation (or the relieving absence of it), redness, and how their skin tolerated daily use.",
    tone: "careful, relieved or disappointed",
    length: "medium",
  },
  {
    key: "comparison_shopper",
    brief:
      "Has tried many competitors in this category (never name real brands, say 'a department-store cream' or 'my old serum'). Positions this product against those experiences.",
    tone: "evaluative",
    length: "medium",
  },
  {
    key: "measured_three_star",
    brief:
      "A genuinely balanced pros-and-cons review. Two things they like, two things they don't, no drama. Reads like someone trying to be fair. (Works for any mid rating.)",
    tone: "even-handed",
    length: "medium",
  },
  {
    key: "polite_disappointed",
    brief:
      "Wanted to love it, didn't. Stays courteous, acknowledges what's fine, explains specifically why it fell short for them (texture, scent, no visible change). No anger.",
    tone: "gentle, deflated",
    length: "short",
  },
  {
    key: "texture_obsessed",
    brief:
      "Cares about feel above all: how it spreads, sinks in, layers under sunscreen or makeup, whether it pills. Barely mentions results. It's all sensory detail.",
    tone: "sensory, vivid",
    length: "short",
  },
  {
    key: "results_diarist",
    brief:
      "Structures the review as a timeline: first impressions, week two, one month, now. Small dated observations rather than grand claims.",
    tone: "documentary",
    length: "long",
  },
  {
    key: "busy_parent",
    brief:
      "Has ninety seconds a day for skincare. Values speed and simplicity; judges the product on whether it fits a rushed life and still does something.",
    tone: "hurried, no-nonsense",
    length: "short",
  },
  {
    key: "first_luxury_splurge",
    brief:
      "This is the most they've ever spent on skincare. Nervous-excited energy; they inspect everything (box, jar, texture) and really want it to be worth it.",
    tone: "excited, a little anxious",
    length: "medium",
  },
  {
    key: "packaging_critic",
    brief:
      "Leads with the packaging: pump or jar hygiene, travel-friendliness, how much product you actually get. Results get one sentence at the end.",
    tone: "particular, opinionated",
    length: "short",
  },
  {
    key: "humid_climate_user",
    brief:
      "Lives somewhere hot and humid. Reviews the product through that lens: weight, grease, how it holds up through sweat and sunscreen.",
    tone: "practical, regional",
    length: "short",
  },
  {
    key: "menopause_perspective",
    brief:
      "Skin changed dramatically in their 50s and old products stopped working. Evaluates whether this one actually addresses mature, hormonally-changed skin.",
    tone: "frank, experienced",
    length: "medium",
  },
  {
    key: "partner_bought_it",
    brief:
      "Their partner bought it (for them, or for themselves and it got borrowed). Lighthearted framing, genuine verdict.",
    tone: "amused, casual",
    length: "short",
  },
  {
    key: "travel_size_wisher",
    brief:
      "Loves or likes the product and frames part of the review around wishing there were a travel size / worrying about flying with it.",
    tone: "affectionate, mildly frustrated",
    length: "short",
  },
  {
    key: "esl_phrasing",
    brief:
      "Written by a non-native speaker: grammar slightly off in natural ways (article slips, unusual word order), vocabulary simple, sincerity high. Never mock. It reads earnest.",
    tone: "earnest, simple",
    length: "short",
    quirks: "light grammatical imperfections throughout, no typos-for-comedy",
  },
  {
    key: "emoji_light_enthusiast",
    brief: "Upbeat reviewer who uses one or two emoji naturally (not more). Short bursts of enthusiasm with a concrete detail.",
    tone: "bubbly",
    length: "short",
    quirks: "exactly 1 or 2 emoji",
  },
  {
    key: "caps_then_calm",
    brief:
      "Opens with a short all-caps exclamation (2 to 4 words), then immediately settles into two calm, informative sentences.",
    tone: "explosive then composed",
    length: "short",
    quirks: "first 2 to 4 words uppercase",
  },
  {
    key: "verified_repeat_buyer",
    brief:
      "Mentions this is an auto-repurchase / they ordered again before running out. Focuses on consistency: the product does the same thing every time.",
    tone: "matter-of-fact, loyal",
    length: "short",
  },
  {
    key: "changed_my_routine",
    brief:
      "This product replaced two or three others in their routine. They describe the simplification as the real win, beyond the direct results.",
    tone: "satisfied, streamlined",
    length: "medium",
  },
  {
    key: "fragrance_sensitive",
    brief:
      "Gets headaches or irritation from scented products. Reviews almost entirely through the scent/fragrance-free lens and their skin's response.",
    tone: "relieved or let down",
    length: "short",
  },
  {
    key: "before_after_describer",
    brief:
      "Describes their skin 'before' in unflattering specifics (dullness, lines, dryness) and 'after' in careful, believable improvements. No miracle language.",
    tone: "candid",
    length: "medium",
  },
  {
    key: "weekend_only_user",
    brief:
      "Uses it as a weekend treat rather than daily. Reviews it as a small ritual. The experience matters as much as the outcome.",
    tone: "indulgent, relaxed",
    length: "short",
  },
  {
    key: "budget_conscious_convert",
    brief:
      "Normally buys drugstore. Explains what pushed them upmarket and whether the difference is visible enough to justify staying.",
    tone: "cost-benefit, sincere",
    length: "medium",
  },
  {
    key: "hype_realist",
    brief:
      "Saw this product all over social media and went in expecting disappointment. Delivers a level-headed verdict on what the hype gets right and wrong.",
    tone: "deadpan, fair",
    length: "medium",
  },
  {
    key: "derm_recommended",
    brief:
      "Their dermatologist or aesthetician suggested this type of product. They report following professional advice and what happened, in plain language.",
    tone: "dutiful, trusting",
    length: "short",
  },
  {
    key: "night_routine_specifics",
    brief:
      "Uses it only at night. Describes evening application, how skin feels on waking, and any difference in makeup application the next morning.",
    tone: "observational",
    length: "medium",
  },
  {
    key: "mature_voice_60plus",
    brief:
      "A reviewer in their 60s or 70s with decades of skincare behind them. Unimpressed by trends, precise about what realistic improvement looks like at their age.",
    tone: "dry, seasoned",
    length: "medium",
  },
  {
    key: "oily_combination_balancer",
    brief:
      "Combination or oily skin; most rich products break them out. Reviews pore-feel, shine at midday, and whether it clogged.",
    tone: "wary, specific",
    length: "short",
  },
  {
    key: "patch_tester",
    brief:
      "Methodical to a fault: patch-tested on the jaw for a week before daily use. The caution itself is the personality; verdict delivered like a lab note.",
    tone: "meticulous",
    length: "short",
  },
  {
    key: "seasonal_dryness",
    brief:
      "Skin falls apart every winter (or in dry office air). Judges the product on whether it carried them through the bad season.",
    tone: "grateful or resigned",
    length: "short",
  },
  {
    key: "no_frills_senior_tech",
    brief:
      "Writes like someone who reviews everything they buy online: numbered observations, oddly formal, signs off with a recommendation verdict.",
    tone: "formal, systematic",
    length: "medium",
    quirks: "may use a short numbered list",
  },
  {
    key: "one_word_plus",
    brief: "A one-to-five-word title doing the heavy lifting ('Finally. Just... finally.') and a single-sentence body.",
    tone: "terse, emphatic",
    length: "one_liner",
  },
  {
    key: "typo_casual",
    brief:
      "Warm, dashed-off review typed on a phone: a lowercase start or a small typo, comma splices, genuine affection or annoyance shining through.",
    tone: "casual, unpolished",
    length: "short",
    quirks: "exactly one small typo and relaxed punctuation",
  },
  {
    key: "science_curious",
    brief:
      "Curious about how the product claims to work (from the description) and honest about what they can and cannot verify on their own face. Distinguishes feeling from proof.",
    tone: "thoughtful, epistemic",
    length: "long",
  },
] as const;

/** Guard used by tests/reviewers: SPEC-1.4 requires ≥ 36 distinct briefs. */
export const PERSONA_COUNT: number = PERSONA_BRIEFS.length;

/* ------------------------------------------------------------------------- *
 * Em/en-dash hygiene (SPEC-1.10 §4)
 * ------------------------------------------------------------------------- */

/**
 * Style rule appended to every chunk generation prompt (SPEC-1.10 §4).
 * Deliberately written WITHOUT em/en dashes: the rule must not itself
 * exemplify the character it bans. scrubDashes below is the deterministic
 * backstop for model output that disobeys anyway.
 */
export const STYLE_RULES =
  "Never use em dashes or en dashes anywhere in titles, bodies, or replies. Use commas, periods, or parentheses instead. Real shoppers rarely type dashes.";

const EM_EN_DASH = /[–—]/;

/**
 * Deterministic em/en-dash sanitizer (SPEC-1.10 §4), applied to every parsed
 * title/body/reply in the chunk parsing path (synthetic.server.ts):
 *   - every run of em (—, U+2014) or en (–, U+2013) dashes, together with any
 *     surrounding spaces, becomes ", ";
 *   - doubled commas / double spaces the replacement can create are collapsed;
 *   - a comma stranded at a line edge (the dash opened or closed the line) is
 *     dropped, and the edges are trimmed;
 *   - regular hyphens (-) are never touched.
 * Pure and idempotent — safe to run on already-clean text.
 */
export function scrubDashes(text: string): string {
  if (!EM_EN_DASH.test(text)) return text;
  let out = text.replace(/[ \t]*[–—]+[ \t]*/g, ", ");
  // Collapse ",,", ", ," … into a single ", ".
  out = out.replace(/,[ \t]*(?:,[ \t]*)+/g, ", ");
  out = out.replace(/[ \t]{2,}/g, " ");
  // Commas stranded at line edges read wrong — drop them (newlines are kept).
  out = out.replace(/^[ \t]*,[ \t]*/gm, "");
  out = out.replace(/[ \t]*,[ \t]*$/gm, "");
  return out.trim();
}
