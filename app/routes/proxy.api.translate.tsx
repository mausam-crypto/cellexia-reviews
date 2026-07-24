/**
 * Storefront proxy: `POST /apps/cellexia-reviews/api/translate`
 * → `/proxy/api/translate`.
 *
 * Body: `{ "ids": ["…"], "target": "fr" }` — max 20 ids, `target` must be
 * one of SHOP_LOCALES (SPEC §6). The service answers from TranslationCache
 * first. Rate limited at 120/h per shop:ip (SPEC §10).
 */

import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { SHOP_LOCALES } from "~/types/cellexia";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  readJsonBody,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { getSettings } from "~/services/settings.server";
import { translateReviews } from "~/services/translate.server";

const MAX_IDS = 20;
const REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function loader() {
  return errorJson(405, { _: "method_not_allowed" });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return errorJson(405, { _: "method_not_allowed" });
  }

  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "translate")) {
    return errorJson(429, { _: "rate_limited" });
  }

  // The body is parsed up-front so the SPEC-1.2 gate can read the preview
  // token from it (the request stream is consumed — never re-read). Parsing
  // never throws; the invalid-body 422 stays below, after the disabled check,
  // so live-mode responses are unchanged.
  const body = await readJsonBody(request);
  const previewToken =
    typeof body?.preview_token === "string" ? body.preview_token : null;
  if (!(await requireLiveOrPreview(shop, request, previewToken))) {
    return errorJson(403, { _: "not_live" });
  }

  // Defense in depth: the widget hides translate UI when disabled, but the
  // endpoint must also refuse so the feature is truly off (SPEC §11).
  const settings = await getSettings(shop);
  if (!settings.showTranslate || settings.translationProvider === "off") {
    return errorJson(403, { _: "translation_disabled" });
  }

  if (!body) return errorJson(422, { _: "invalid_body" });

  const idsRaw = body.ids;
  if (!Array.isArray(idsRaw) || idsRaw.length === 0 || idsRaw.length > MAX_IDS) {
    return errorJson(422, { ids: "invalid" });
  }
  const ids: string[] = [];
  for (const entry of idsRaw) {
    if (typeof entry !== "string" || !REVIEW_ID_RE.test(entry)) {
      return errorJson(422, { ids: "invalid" });
    }
    if (!ids.includes(entry)) ids.push(entry);
  }

  const target = typeof body.target === "string" ? body.target.trim() : "";
  if (!(SHOP_LOCALES as readonly string[]).includes(target)) {
    return errorJson(422, { target: "invalid" });
  }

  try {
    const translations = await translateReviews(shop, ids, target);
    return json({ ok: true, translations }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    console.error("[cellexia] translateReviews failed", error);
    return errorJson(500, { _: "server_error" });
  }
}
