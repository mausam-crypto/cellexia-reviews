/**
 * Cellexia Reviews — per-shop settings service.
 *
 * `getSettings` upserts a row with schema defaults so callers always receive a
 * complete Setting object. `updateSettings` accepts a partial patch, sanitizes
 * every field (unknown keys are ignored, values are clamped/normalized) and
 * persists it. Neither function ever trusts `shop` values coming from a request
 * body — callers pass the shop resolved from an authenticated session or a
 * verified app-proxy signature.
 */
import crypto from "node:crypto";
import type { Setting } from "@prisma/client";
import prisma from "~/db.server";
import { DESIGN_THEMES, RANKING_STRATEGIES, TRANSLATION_DISPLAYS } from "~/types/cellexia";

const AI_PROVIDERS = ["anthropic", "off"] as const;
const TRANSLATION_PROVIDERS = ["anthropic", "deepl", "google", "off"] as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Trim a nullable string; empty strings become null. Exported (v1.34) so the
 * Settings test intent can apply the exact save-path length caps when
 * building its candidate row — the test-equals-save invariant.
 */
export function normalizeNullable(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Canonicalize the v1.8 ranking-boost JSON (SPEC-1.8 §1): only the two known
 * flags survive, only when strictly `true`, serialized in a fixed key order so
 * the stored value is deterministic. Anything unparsable becomes "{}" — the
 * column default and the no-boost behavior — rather than corrupting the row.
 */
function sanitizeRankingBoosts(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return "{}";
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "{}";
  const flags = parsed as { boostVerified?: unknown; boostMedia?: unknown };
  const out: { boostVerified?: true; boostMedia?: true } = {};
  if (flags.boostVerified === true) out.boostVerified = true;
  if (flags.boostMedia === true) out.boostMedia = true;
  return JSON.stringify(out);
}

/* ------------------------------------------------------------------------- *
 * v1.14 (SPEC-1.14) — market scope + Stamped selector sanitization
 * ------------------------------------------------------------------------- */

/**
 * Shipped default hide-selectors for the Stamped takeover — MEASURED from
 * cellexialabs.com (2026-07-31, SPEC-1.14 §4). Exported so the admin UI can
 * show them and the metafield sync can fall back to them.
 */
export const DEFAULT_STAMPED_SELECTORS = [
  "#stamped-main-widget",
  ":is(section, div):has(> #stamped-main-widget)",
  ".pdp__reviews:has(.stamped-product-reviews-badge)",
  "a.product-review-link:has(> .stamped-product-reviews-badge)",
  ".stamped-product-reviews-badge",
];

export class SelectorValidationError extends Error {}

/**
 * Newline-separated CSS selector list → stored string, or null for "use the
 * shipped defaults". Only selector-safe characters survive (SPEC-1.14 §4):
 * `{ } ; < @ /` are rejected outright, which makes it impossible to break out
 * of the `<style>` tag or smuggle at-rules/comments through the metafield.
 */
export function sanitizeStampedSelectors(value: string | null): string | null {
  if (value === null) return null;
  const lines = String(value)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;
  if (lines.length > 20) {
    throw new SelectorValidationError("Too many selectors (max 20 lines).");
  }
  const allowed = /^[A-Za-z0-9 _.#:*>+~,()[\]="'-]+$/;
  for (const line of lines) {
    if (line.length > 200) {
      throw new SelectorValidationError(`Selector too long (max 200 chars): "${line.slice(0, 60)}…"`);
    }
    if (!allowed.test(line)) {
      throw new SelectorValidationError(
        `Selector contains unsupported characters: "${line.slice(0, 80)}". Allowed: letters, digits, spaces and _.#:*>+~,()[]="'-`,
      );
    }
  }
  const joined = lines.join("\n");
  if (joined.length > 2000) {
    throw new SelectorValidationError("Selector list too long (max 2000 characters).");
  }
  return joined;
}

/** Canonical JSON array of deduped, lowercased, plausible market handles. */
export function sanitizeMarketHandles(value: unknown): string {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return "[]";
    }
  }
  if (!Array.isArray(parsed)) return "[]";
  const seen = new Set<string>();
  for (const item of parsed) {
    const handle = String(item ?? "").trim().toLowerCase();
    // Shopify market handles: url-safe slugs.
    if (handle.length > 0 && handle.length <= 64 && /^[a-z0-9-]+$/.test(handle)) {
      seen.add(handle);
    }
    if (seen.size >= 50) break;
  }
  return JSON.stringify([...seen]);
}

/** Parsed accessor for Setting.liveMarkets. */
export function parseLiveMarkets(settings: Setting): string[] {
  try {
    const parsed = JSON.parse(settings.liveMarkets);
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------- *
 * v1.34 (SPEC-1.34) — low-star alert sanitizers
 * ------------------------------------------------------------------------- */

// Same shape the storefront submit route accepts for author emails. Defined
// here (not imported from alerts.server) to keep this module dependency-free:
// alerts.server imports settings.server.
const ALERT_SETTINGS_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Canonicalize a recipient list: split on commas/semicolons/whitespace, keep
 * plausible addresses only, dedupe case-insensitively, cap at 5, join with
 * ", ". Empty result → null (the alert falls back to notifyEmail).
 */
export function sanitizeRecipients(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(value).split(/[\s,;]+/)) {
    const addr = part.trim();
    if (!addr || addr.length > 254 || !ALERT_SETTINGS_EMAIL_RE.test(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
    if (out.length >= 5) break;
  }
  return out.length > 0 ? out.join(", ") : null;
}

/**
 * From address for alert email: must be a single plain address ("Name
 * <addr>" display forms are rejected — nodemailer gets the display name
 * separately). Shared by updateSettings and the Settings test intent so the
 * tested and saved values can never diverge.
 */
export function sanitizeAlertFromEmail(value: string | null | undefined): string | null {
  const from = normalizeNullable(value ?? null, 254);
  return from && ALERT_SETTINGS_EMAIL_RE.test(from) ? from : null;
}

/**
 * Hostname (or IPv4) for the SMTP server: label characters only — anything
 * else (spaces, slashes, a pasted URL scheme) is rejected to null so a broken
 * value can never reach the transport. The route warns inline on rejection;
 * "smtp://host" style pastes are stripped to their host first.
 */
export function sanitizeSmtpHost(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  let host = String(value).trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").replace(/\/.*$/, "");
  if (host.length === 0 || host.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host)) return null;
  return host;
}

/**
 * Returns the settings row for a shop, creating it with defaults on first use.
 *
 * SPEC-1.2: the preview token is lazily generated (crypto.randomUUID) and
 * persisted the first time it is needed, so every shop always has a stable
 * token for tokenized live-theme preview links. Regenerating the token
 * (Settings → "Regenerate preview link") invalidates old links.
 */
export async function getSettings(shop: string): Promise<Setting> {
  const settings = await prisma.setting.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  if (settings.previewToken == null) {
    return prisma.setting.update({
      where: { shop },
      data: { previewToken: crypto.randomUUID() },
    });
  }
  return settings;
}

/**
 * Applies a sanitized partial update and returns the resulting settings row.
 * Unknown or invalid values are silently dropped rather than throwing, so a
 * malformed admin form submission can never corrupt the row.
 */
export async function updateSettings(shop: string, patch: Partial<Setting>): Promise<Setting> {
  const data: Partial<Omit<Setting, "shop">> = {};

  // Booleans
  if (typeof patch.autoPublish === "boolean") data.autoPublish = patch.autoPublish;
  if (typeof patch.showTranslate === "boolean") data.showTranslate = patch.showTranslate;
  if (typeof patch.showSummary === "boolean") data.showSummary = patch.showSummary;
  if (typeof patch.showMediaStrip === "boolean") data.showMediaStrip = patch.showMediaStrip;
  if (typeof patch.emitJsonLd === "boolean") data.emitJsonLd = patch.emitJsonLd;
  if (typeof patch.isLive === "boolean") data.isLive = patch.isLive;
  if (typeof patch.hideStamped === "boolean") data.hideStamped = patch.hideStamped;
  if (typeof patch.showQna === "boolean") data.showQna = patch.showQna;

  // v1.17 (SPEC-1.17 §1): AI Curator inputs.
  if (patch.curationInstructions !== undefined) {
    data.curationInstructions = normalizeNullable(patch.curationInstructions, 1000);
  }
  if (typeof patch.curationOverviewField === "string") {
    const field = patch.curationOverviewField.trim().slice(0, 120);
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(field)) data.curationOverviewField = field;
    else if (field === "") data.curationOverviewField = "accentuate.overview";
  }

  // v1.20 (SPEC-1.20 §3): optional curation spend ceiling. null clears it;
  // a negative or non-finite value is dropped rather than stored.
  if (patch.curationBudgetUsd !== undefined) {
    if (patch.curationBudgetUsd === null) {
      data.curationBudgetUsd = null;
    } else {
      const value = Number(patch.curationBudgetUsd);
      if (Number.isFinite(value) && value >= 0) {
        data.curationBudgetUsd = Math.round(value * 100) / 100;
      }
    }
  }

  // v1.19 (SPEC-1.19 §6): brand-page feature toggles — canonicalized to the
  // two known boolean keys, anything else dropped.
  if (typeof patch.brandPageConfig === "string") {
    try {
      const parsed = JSON.parse(patch.brandPageConfig) as Record<string, unknown>;
      data.brandPageConfig = JSON.stringify({
        ask: parsed.ask !== false,
        recommend: parsed.recommend !== false,
      });
    } catch {
      /* invalid JSON — dropped */
    }
  }

  // v1.18 (SPEC-1.18): candidate source + automatic refresh, whitelisted.
  if (patch.curationSource === "as_seen" || patch.curationSource === "all_translated") {
    data.curationSource = patch.curationSource;
  }
  if (
    patch.curationRefresh === "manual" ||
    patch.curationRefresh === "daily" ||
    patch.curationRefresh === "weekly"
  ) {
    data.curationRefresh = patch.curationRefresh;
  }

  // v1.14 (SPEC-1.14 §1): market scope. Invalid scope values are dropped;
  // liveMarkets is canonicalized to a deduped array of plausible handles.
  if (patch.liveScope === "all" || patch.liveScope === "markets") {
    data.liveScope = patch.liveScope;
  }
  if (patch.liveMarkets !== undefined) {
    data.liveMarkets = sanitizeMarketHandles(patch.liveMarkets);
  }
  if (patch.stampedSelectors !== undefined) {
    // null/empty ⇒ null (shipped defaults); otherwise the sanitizer throws a
    // SelectorValidationError naming the offending line — the route surfaces
    // it inline instead of silently persisting a broken/hostile selector.
    data.stampedSelectors = sanitizeStampedSelectors(patch.stampedSelectors);
  }

  // Preview token: a non-empty string replaces it (regenerate flow); null
  // clears it, after which getSettings lazily mints a fresh one. Either way
  // previously shared preview links stop working.
  if (patch.previewToken !== undefined) {
    data.previewToken = normalizeNullable(patch.previewToken, 128);
  }

  // Strings with fixed vocabularies
  if (
    typeof patch.aiProvider === "string" &&
    (AI_PROVIDERS as readonly string[]).includes(patch.aiProvider)
  ) {
    data.aiProvider = patch.aiProvider;
  }
  if (
    typeof patch.translationProvider === "string" &&
    (TRANSLATION_PROVIDERS as readonly string[]).includes(patch.translationProvider)
  ) {
    data.translationProvider = patch.translationProvider;
  }
  if (patch.designTheme !== undefined) {
    // Unknown design versions fall back to the default skin (SPEC-1.1).
    data.designTheme =
      typeof patch.designTheme === "string" &&
      (DESIGN_THEMES as readonly string[]).includes(patch.designTheme)
        ? patch.designTheme
        : "amazon";
  }
  if (patch.rankingStrategy !== undefined) {
    // v1.8 (SPEC-1.8 §1): unknown display-order systems fall back to the
    // shipped default, which is byte-compatible with the pre-1.8 "top" sort.
    data.rankingStrategy =
      typeof patch.rankingStrategy === "string" &&
      (RANKING_STRATEGIES as readonly string[]).includes(patch.rankingStrategy)
        ? patch.rankingStrategy
        : "amazon_top";
  }
  if (patch.translationDisplay !== undefined) {
    // v1.8 (SPEC-1.8 §4): unknown modes fall back to the pre-1.8 behavior.
    data.translationDisplay =
      typeof patch.translationDisplay === "string" &&
      (TRANSLATION_DISPLAYS as readonly string[]).includes(patch.translationDisplay)
        ? patch.translationDisplay
        : "original";
  }
  if (patch.rankingBoosts !== undefined) {
    data.rankingBoosts = sanitizeRankingBoosts(patch.rankingBoosts);
  }

  // Free-form strings
  if (typeof patch.brandDisplayName === "string") {
    const name = patch.brandDisplayName.trim().slice(0, 80);
    if (name.length > 0) data.brandDisplayName = name;
  }
  if (patch.notifyEmail !== undefined) {
    data.notifyEmail = normalizeNullable(patch.notifyEmail, 254);
  }
  if (typeof patch.aiModel === "string") {
    const model = patch.aiModel.trim().slice(0, 100);
    if (model.length > 0) data.aiModel = model;
  }

  // API keys — empty string clears the key (stored as null)
  if (patch.anthropicApiKey !== undefined) {
    data.anthropicApiKey = normalizeNullable(patch.anthropicApiKey, 512);
  }
  if (patch.deeplApiKey !== undefined) {
    data.deeplApiKey = normalizeNullable(patch.deeplApiKey, 512);
  }
  if (patch.googleApiKey !== undefined) {
    data.googleApiKey = normalizeNullable(patch.googleApiKey, 512);
  }

  // Integers
  if (patch.reviewsPerPage !== undefined) {
    data.reviewsPerPage = clampInt(patch.reviewsPerPage, 1, 50, 10);
  }
  if (patch.summaryAutoThreshold !== undefined) {
    data.summaryAutoThreshold = clampInt(patch.summaryAutoThreshold, 1, 100, 5);
  }

  // v1.34 (SPEC-1.34): low-star review support alerts. The route validates
  // user-facing fields and reports problems inline; these sanitizers are the
  // last line of defense and stay lenient like the rest of this module.
  if (typeof patch.lowStarAlerts === "boolean") data.lowStarAlerts = patch.lowStarAlerts;
  if (patch.lowStarAlertMax !== undefined) {
    data.lowStarAlertMax = clampInt(patch.lowStarAlertMax, 1, 3, 2);
  }
  if (patch.alertRecipients !== undefined) {
    // Canonicalized to a comma-separated list of plausible addresses (max 5);
    // an empty/invalid list clears the override (falls back to notifyEmail).
    data.alertRecipients = sanitizeRecipients(patch.alertRecipients);
  }
  if (patch.smtpHost !== undefined) data.smtpHost = sanitizeSmtpHost(patch.smtpHost);
  if (patch.smtpPort !== undefined) data.smtpPort = clampInt(patch.smtpPort, 1, 65535, 587);
  if (
    patch.smtpSecurity === "starttls" ||
    patch.smtpSecurity === "tls" ||
    patch.smtpSecurity === "none"
  ) {
    data.smtpSecurity = patch.smtpSecurity;
  }
  if (patch.smtpUser !== undefined) data.smtpUser = normalizeNullable(patch.smtpUser, 254);
  // Password: like the API keys, empty string clears (stored as null).
  if (patch.smtpPass !== undefined) data.smtpPass = normalizeNullable(patch.smtpPass, 512);
  if (patch.alertFromEmail !== undefined) {
    data.alertFromEmail = sanitizeAlertFromEmail(patch.alertFromEmail);
  }

  return prisma.setting.upsert({
    where: { shop },
    update: data,
    create: { shop, ...data },
  });
}
