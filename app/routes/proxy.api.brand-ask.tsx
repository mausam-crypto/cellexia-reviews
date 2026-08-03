/**
 * Storefront proxy: `POST /apps/<subpath>/api/brand-ask` (SPEC-1.19 §9).
 *
 * The "Cellexia Reviews" page's two ask boxes:
 *   mode "ask"       — brand-wide question answered from reviews;
 *   mode "recommend" — "which product is right for me?" grounded in reviews,
 *                      answering with 1–2 corpus-validated products.
 *
 * Body (JSON): { question, mode?, locale?, preview_token? }.
 * Response: { answer, quotes: [...], products?: [{id,title,handle}] }.
 *
 * Same rails as /api/ask: proxy-verified, body-token live/preview gating,
 * `ask` rate bucket + qna.server's shared daily cap, no-store responses.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  NO_STORE_HEADERS,
  errorJson,
  getClientIp,
  matchShopLocale,
  recordStorefrontHit,
  requireLiveOrPreview,
  verifyProxy,
} from "~/services/proxy.server";
import { checkRateLimit } from "~/services/ratelimit.server";
import { askBrand } from "~/services/qna.server";

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return errorJson(405, { _: "method_not_allowed" });
  const auth = await verifyProxy(request);
  if (!auth) return errorJson(401, { _: "unauthorized" });
  const { shop } = auth;
  recordStorefrontHit(shop, request);

  const ip = getClientIp(request);
  if (!checkRateLimit(shop, ip, "ask")) return errorJson(429, { _: "rate_limited" });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return errorJson(400, { _: "invalid_json" });
  }

  const previewToken = typeof body.preview_token === "string" ? body.preview_token : null;
  if (!(await requireLiveOrPreview(shop, request, previewToken))) {
    return errorJson(403, { _: "not_live" });
  }

  const question = String(body.question ?? "").trim();
  if (question.length < 3 || question.length > 200) {
    return errorJson(422, { question: "invalid" });
  }
  const mode = body.mode === "recommend" ? "recommend" : "ask";
  const locale = matchShopLocale(typeof body.locale === "string" ? body.locale : null);

  try {
    const result = await askBrand(shop, question, mode, locale);
    switch (result.status) {
      case "ok":
        return json(result.response, { headers: NO_STORE_HEADERS });
      case "capped":
        return errorJson(429, { _: "rate_limited" });
      case "no_ai":
        return errorJson(403, { _: "qna_disabled" });
      default:
        return errorJson(502, { _: "qna_failed" });
    }
  } catch (error) {
    console.error("[cellexia] askBrand failed", error);
    return errorJson(500, { _: "server_error" });
  }
}

export async function loader() {
  return errorJson(405, { _: "method_not_allowed" });
}
