/**
 * English label maps for the structured option keys defined in ~/types/cellexia (SPEC §5).
 * The Polaris admin is English-only, so these labels are defined here (the storefront widget
 * uses the extension locale files instead). Keep the keys in sync with §5 of SPEC.md.
 */

export const AGE_RANGE_LABELS: Record<string, string> = {
  under_25: "Under 25",
  "25_34": "25–34",
  "35_44": "35–44",
  "45_54": "45–54",
  "55_64": "55–64",
  "65_plus": "65+",
};

export const SKIN_CONCERN_LABELS: Record<string, string> = {
  fine_lines: "Fine lines & wrinkles",
  dark_spots: "Dark spots",
  dryness: "Dryness",
  dullness: "Dullness",
  firmness: "Loss of firmness",
  texture: "Uneven texture",
  sensitivity: "Sensitive skin",
  redness: "Redness",
  pores: "Visible pores",
  dark_circles: "Dark circles",
};

export const TIME_USING_LABELS: Record<string, string> = {
  lt_1w: "Less than 1 week",
  w1_4: "1–4 weeks",
  m1_3: "1–3 months",
  m3_6: "3–6 months",
  gt_6m: "More than 6 months",
};

export const RESULTS_SEEN_LABELS: Record<string, string> = {
  smoother: "Smoother texture",
  fewer_lines: "Reduced fine lines",
  firmer: "Firmer skin",
  radiance: "More radiance",
  even_tone: "More even tone",
  hydration: "Deep hydration",
  calmer: "Calmer, less irritated skin",
  too_early: "Too early to tell",
};

export const REPORT_REASON_LABELS: Record<string, string> = {
  off_topic: "Not about the product",
  inappropriate: "Inappropriate or offensive",
  spam: "Spam or advertising",
  privacy: "Privacy concern",
  other: "Other",
};

export const STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  PUBLISHED: "Published",
  REJECTED: "Rejected",
  SPAM: "Spam",
};

export const LOCALE_LABELS: Record<string, string> = {
  en: "English",
  fr: "French",
  de: "German",
  da: "Danish",
  sv: "Swedish",
  fi: "Finnish",
  nl: "Dutch",
  it: "Italian",
  es: "Spanish",
  ar: "Arabic",
  pl: "Polish",
  "pt-PT": "Portuguese (Portugal)",
  ja: "Japanese",
  nb: "Norwegian (Bokmål)",
  ro: "Romanian",
  hu: "Hungarian",
  el: "Greek",
};

/** Parses a JSON-array-of-strings column (Review.skinConcerns / Review.resultsSeen). */
export function parseKeyArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed.filter((v): v is string => typeof v === "string");
      }
    } catch {
      // fall through — not JSON
    }
  }
  return [];
}

export function labelFor(
  key: string | null | undefined,
  map: Record<string, string>,
): string | null {
  if (!key) return null;
  return map[key] ?? key;
}

export function labelsFor(keys: string[], map: Record<string, string>): string[] {
  return keys.map((k) => map[k] ?? k);
}

export function formatDate(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}
