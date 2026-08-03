import type { ActionFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { invalidateAskAnswers } from "~/services/qna.server";

/**
 * Single route for the three mandatory GDPR compliance webhooks
 * (configured in shopify.app.toml → [[webhooks.subscriptions]]
 * compliance_topics, uri "/webhooks/gdpr"):
 *
 *   - customers/data_request — acknowledged; the merchant exports the
 *     customer's reviews from the admin and responds manually.
 *   - customers/redact — deletes every review matching the customer's
 *     email and/or customer id (media and votes cascade).
 *   - shop/redact — deletes all data the app holds for the shop.
 */

const CHUNK_SIZE = 500; // stay well under SQLite's bound-parameter limit

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function deleteReviewsByIds(shop: string, ids: string[]) {
  for (const ids_ of chunk(ids, CHUNK_SIZE)) {
    // TranslationCache has no relation to Review, so clear it explicitly.
    await db.translationCache.deleteMany({ where: { reviewId: { in: ids_ } } });
    // ReviewMedia and Vote rows cascade with the review.
    await db.review.deleteMany({ where: { id: { in: ids_ } } });
  }
  // v1.16 review fix: cached Q&A answers can quote the deleted reviews —
  // a redaction request must reach them too. Product-level granularity is
  // unnecessary here; correctness beats cache warmth on a GDPR path.
  await invalidateAskAnswers(shop);
  // v1.19: the brand page's stored AI analysis embeds verbatim review
  // excerpts with author names — a redaction must purge it (it is fully
  // regenerable from the remaining reviews).
  await db.brandAnalysis.deleteMany({ where: { shop } });
  // The PUBLISHED brand-page metafield still holds the redacted customer's
  // name and review text — republish it from the remaining reviews (offline
  // session: a webhook has no admin context). Best effort: a failure here
  // must not fail the redaction, and the next publish self-heals.
  try {
    const { unauthenticated } = await import("~/shopify.server");
    const { admin } = await unauthenticated.admin(shop);
    const { publishBrandPage } = await import("~/services/brand-page.server");
    await publishBrandPage(shop, admin);
  } catch (error) {
    console.error("[cellexia] brand-page republish after redaction failed", error);
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customer = (
    payload as { customer?: { id?: number | string | null; email?: string | null } }
  ).customer;

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      // Nothing is sent automatically: the reviews we hold for a customer are
      // their name, email and review content. The merchant exports them
      // (Import / Export → Export CSV) and responds to the request directly.
      console.log(
        `Data request for customer ${customer?.id ?? "unknown"} on ${shop} — ` +
          "export their reviews from the app admin and respond manually.",
      );
      break;
    }

    case "CUSTOMERS_REDACT": {
      const conditions = [];
      if (customer?.email) {
        // createReview stores authorEmail lowercased, so normalize the payload
        // email the same way (SQLite string equality is case-sensitive). Keep
        // the raw form too, defensively, for rows stored before normalization.
        const email = String(customer.email).trim();
        conditions.push({ authorEmail: email.toLowerCase() });
        if (email !== email.toLowerCase()) {
          conditions.push({ authorEmail: email });
        }
      }
      if (customer?.id !== undefined && customer?.id !== null) {
        conditions.push({ customerId: String(customer.id) });
      }
      if (conditions.length > 0) {
        const reviews = await db.review.findMany({
          where: { shop, OR: conditions },
          select: { id: true },
        });
        if (reviews.length > 0) {
          await deleteReviewsByIds(shop, reviews.map((review) => review.id));
        }
        console.log(
          `Redacted ${reviews.length} review(s) for customer ${customer?.id ?? "unknown"} on ${shop}`,
        );
      }
      break;
    }

    case "SHOP_REDACT": {
      const reviews = await db.review.findMany({
        where: { shop },
        select: { id: true },
      });
      if (reviews.length > 0) {
        await deleteReviewsByIds(shop, reviews.map((review) => review.id));
      }
      await db.summary.deleteMany({ where: { shop } });
      // v1.17/v1.19 derived tables that hold review-derived content.
      await db.aiCuration.deleteMany({ where: { shop } });
      await db.brandAnalysis.deleteMany({ where: { shop } });
      await db.productDisplayConfig.deleteMany({ where: { shop } });
      await db.generationJob.deleteMany({ where: { shop } });
      await db.setting.deleteMany({ where: { shop } });
      await db.session.deleteMany({ where: { shop } });
      console.log(`Redacted all app data for ${shop}`);
      break;
    }

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};
