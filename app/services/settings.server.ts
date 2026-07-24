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
import { DESIGN_THEMES } from "~/types/cellexia";

const AI_PROVIDERS = ["anthropic", "off"] as const;
const TRANSLATION_PROVIDERS = ["anthropic", "deepl", "google", "off"] as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Trim a nullable string; empty strings become null. */
function normalizeNullable(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : null;
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

  return prisma.setting.upsert({
    where: { shop },
    update: data,
    create: { shop, ...data },
  });
}
