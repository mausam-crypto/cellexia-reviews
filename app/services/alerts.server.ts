/**
 * Cellexia Reviews — low-star review support alerts (SPEC-1.34).
 *
 * When the merchant enables `Setting.lowStarAlerts` (OFF by default), every
 * review submitted FROM THE STOREFRONT with a rating at or below
 * `Setting.lowStarAlertMax` (1..3, default 2 = "1–2 stars") emails the support
 * team a full copy of the review plus the customer's contact details and their
 * recent orders — the moment the review is created, whether it lands as
 * PENDING or auto-publishes. Pointing the recipient list at a helpdesk's
 * inbound address (Gorgias, Zendesk, Freshdesk, a shared Gmail…) turns every
 * alert into a support ticket with the customer on Reply-To.
 *
 * Design rules:
 *  - The alert path NEVER affects the submission: `maybeSendLowStarAlert` is
 *    fire-and-forget, catches everything, and the route does not await it.
 *  - Order lookup is best-effort and HONEST: when the Shopify call fails the
 *    email says "the order lookup failed", never "no orders found"
 *    (the v1.20.1 no_product lesson).
 *  - Every user-controlled string is HTML-escaped in the HTML part and
 *    newline-stripped in headers (subject / Reply-To name).
 *  - Outcomes are recorded on the Setting row (lastAlertAt / lastAlertError,
 *    the lastSyncError pattern) so a silently failing SMTP setup is visible
 *    in Settings instead of being discovered weeks later.
 *  - A per-shop hourly cap (ratelimit.server "alert" bucket) bounds inbox
 *    flooding if a bot floods 1-star submissions past the per-IP submit cap.
 */
import nodemailer from "nodemailer";
import type { Review, Setting } from "@prisma/client";
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";
import prisma from "~/db.server";
import { getSettings } from "./settings.server";
import { checkRateLimit } from "./ratelimit.server";
import {
  AGE_RANGE_LABELS,
  LOCALE_LABELS,
  RESULTS_SEEN_LABELS,
  SKIN_CONCERN_LABELS,
  TIME_USING_LABELS,
  labelFor,
  labelsFor,
  parseKeyArray,
} from "~/components/admin/labels";

/** Same structural admin-client shape as verified.server.ts — graphql only. */
type AdminClient = Pick<BaseAdminApiContext, "graphql">;

export const ALERT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const SMTP_SECURITIES = ["starttls", "tls", "none"] as const;
export type SmtpSecurity = (typeof SMTP_SECURITIES)[number];

const MAX_RECIPIENTS = 5;
const ERROR_MAX = 500;

/* ------------------------------------------------------------------------- *
 * Recipients + config
 * ------------------------------------------------------------------------- */

/**
 * Split a stored/typed recipient list on commas, semicolons or whitespace and
 * keep only plausible addresses (deduped case-insensitively, capped at 5).
 */
export function parseRecipientList(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of String(value).split(/[\s,;]+/)) {
    const addr = part.trim();
    if (!addr || addr.length > 254 || !ALERT_EMAIL_RE.test(addr)) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
    if (out.length >= MAX_RECIPIENTS) break;
  }
  return out;
}

/** Effective recipients: alertRecipients, falling back to notifyEmail. */
export function effectiveRecipients(
  settings: Pick<Setting, "alertRecipients" | "notifyEmail">,
): string[] {
  const explicit = parseRecipientList(settings.alertRecipients);
  if (explicit.length > 0) return explicit;
  return parseRecipientList(settings.notifyEmail);
}

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string | null;
  pass: string | null;
  from: string;
}

export type SmtpConfigError = "no_host" | "no_from";

/**
 * Resolve the transport config from a Setting row. The From address falls
 * back to the SMTP username when it looks like an email address — the usual
 * case, and the address most likely to pass the provider's alignment checks.
 */
export function resolveSmtpConfig(
  settings: Pick<
    Setting,
    "smtpHost" | "smtpPort" | "smtpSecurity" | "smtpUser" | "smtpPass" | "alertFromEmail"
  >,
): SmtpConfig | SmtpConfigError {
  const host = (settings.smtpHost ?? "").trim();
  if (!host) return "no_host";
  const security = (SMTP_SECURITIES as readonly string[]).includes(settings.smtpSecurity)
    ? (settings.smtpSecurity as SmtpSecurity)
    : "starttls";
  const user = (settings.smtpUser ?? "").trim() || null;
  const explicitFrom = (settings.alertFromEmail ?? "").trim();
  const from = explicitFrom && ALERT_EMAIL_RE.test(explicitFrom)
    ? explicitFrom
    : user && ALERT_EMAIL_RE.test(user)
      ? user
      : "";
  if (!from) return "no_from";
  const port =
    Number.isInteger(settings.smtpPort) && settings.smtpPort >= 1 && settings.smtpPort <= 65535
      ? settings.smtpPort
      : 587;
  return { host, port, security, user, pass: settings.smtpPass ?? null, from };
}

/* ------------------------------------------------------------------------- *
 * Should this review alert?
 * ------------------------------------------------------------------------- */

/**
 * Pure gate: master toggle on, storefront-submitted (never QA-generated,
 * CSV-imported or bulk-added rows), rating at or below the threshold.
 */
export function shouldAlert(
  settings: Pick<Setting, "lowStarAlerts" | "lowStarAlertMax">,
  review: Pick<Review, "rating" | "source" | "isSynthetic">,
): boolean {
  if (!settings.lowStarAlerts) return false;
  if (review.isSynthetic) return false;
  if (review.source !== "storefront") return false;
  const max = clampThreshold(settings.lowStarAlertMax);
  return review.rating <= max;
}

export function clampThreshold(value: number): number {
  if (!Number.isInteger(value)) return 2;
  return Math.min(3, Math.max(1, value));
}

/* ------------------------------------------------------------------------- *
 * Order + customer context (best-effort, honest about failure)
 * ------------------------------------------------------------------------- */

export interface AlertOrderItem {
  title: string;
  quantity: number;
  variantTitle: string | null;
  isReviewedProduct: boolean;
}

export interface AlertOrder {
  /** Numeric Shopify order id as a string; "" when unparsable. */
  id: string;
  name: string;
  createdAt: string | null;
  fulfillment: string | null;
  financial: string | null;
  total: string | null;
  items: AlertOrderItem[];
  containsReviewedProduct: boolean;
}

export interface AlertCustomer {
  /** Numeric Shopify customer id as a string; null when unknown. */
  id: string | null;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  ordersCount: string | null;
}

export type OrderLookupStatus = "ok" | "failed" | "unavailable";

export interface OrderContext {
  status: OrderLookupStatus;
  orders: AlertOrder[];
  customer: AlertCustomer | null;
}

const ALERT_ORDERS_QUERY = `#graphql
  query CellexiaAlertOrders($query: String!) {
    orders(first: 5, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        displayFulfillmentStatus
        displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
        customer { id displayName email phone numberOfOrders }
        lineItems(first: 20) {
          nodes {
            title
            quantity
            variantTitle
            product { id }
          }
        }
      }
    }
  }
`;

interface OrdersQueryResult {
  data?: {
    orders?: {
      nodes?: Array<{
        id?: string;
        name?: string;
        createdAt?: string;
        displayFulfillmentStatus?: string | null;
        displayFinancialStatus?: string | null;
        totalPriceSet?: { shopMoney?: { amount?: string; currencyCode?: string } | null } | null;
        customer?: {
          id?: string;
          displayName?: string | null;
          email?: string | null;
          phone?: string | null;
          numberOfOrders?: string | number | null;
        } | null;
        lineItems?: {
          nodes?: Array<{
            title?: string | null;
            quantity?: number | null;
            variantTitle?: string | null;
            product?: { id?: string | null } | null;
          }>;
        };
      }>;
    };
  };
  errors?: unknown;
}

function numericIdFromGid(gid: string | undefined | null): string {
  const match = String(gid ?? "").match(/\/(\d+)$/);
  return match ? match[1] : "";
}

/**
 * Fetch the customer's recent orders (newest first): by `customer_id` when the
 * shopper was logged in, else by the submitted email. Mirrors the
 * verified.server.ts query-preference order and its query sanitization.
 */
export async function collectOrderContext(
  admin: AdminClient | null,
  review: Pick<Review, "productId" | "authorEmail" | "customerId">,
): Promise<OrderContext> {
  if (!admin) return { status: "unavailable", orders: [], customer: null };

  const queries: string[] = [];
  const numericCustomerId = review.customerId ? String(review.customerId).replace(/\D/g, "") : "";
  if (numericCustomerId) queries.push(`customer_id:${numericCustomerId}`);
  const safeEmail = review.authorEmail
    ? String(review.authorEmail).trim().toLowerCase().replace(/["\\\s]/g, "")
    : "";
  if (safeEmail && safeEmail.includes("@")) queries.push(`email:"${safeEmail}"`);
  if (queries.length === 0) return { status: "ok", orders: [], customer: null };

  const pid = String(review.productId).replace(/\D/g, "");
  let sawFailure = false;

  for (const query of queries) {
    try {
      const response = await admin.graphql(ALERT_ORDERS_QUERY, { variables: { query } });
      const json = (await response.json()) as OrdersQueryResult;
      if (json.errors) {
        console.error("[cellexia] alert orders query errors:", json.errors);
        sawFailure = true;
        continue;
      }
      const nodes = json.data?.orders?.nodes ?? [];
      if (nodes.length === 0) continue; // try the next query key
      const orders: AlertOrder[] = nodes.map((node) => {
        const items: AlertOrderItem[] = (node.lineItems?.nodes ?? []).map((item) => ({
          title: String(item.title ?? "").slice(0, 255),
          quantity: typeof item.quantity === "number" ? item.quantity : 0,
          variantTitle: item.variantTitle ? String(item.variantTitle).slice(0, 255) : null,
          isReviewedProduct: Boolean(pid) && numericIdFromGid(item.product?.id) === pid,
        }));
        const money = node.totalPriceSet?.shopMoney;
        return {
          id: numericIdFromGid(node.id),
          name: String(node.name ?? "").slice(0, 64),
          createdAt: node.createdAt ?? null,
          fulfillment: node.displayFulfillmentStatus ?? null,
          financial: node.displayFinancialStatus ?? null,
          total: money?.amount ? `${money.amount} ${money.currencyCode ?? ""}`.trim() : null,
          items,
          containsReviewedProduct: items.some((item) => item.isReviewedProduct),
        };
      });
      const first = nodes[0]?.customer;
      const customer: AlertCustomer | null = first
        ? {
            id: numericIdFromGid(first.id) || null,
            displayName: first.displayName ?? null,
            email: first.email ?? null,
            phone: first.phone ?? null,
            ordersCount: first.numberOfOrders != null ? String(first.numberOfOrders) : null,
          }
        : null;
      return { status: "ok", orders, customer };
    } catch (error) {
      console.error("[cellexia] alert orders lookup failed", error);
      sawFailure = true;
    }
  }

  // No query returned orders. If any attempt errored, say so — an email that
  // claims "no orders" after a throttled/failed call would mislead support.
  return { status: sawFailure ? "failed" : "ok", orders: [], customer: null };
}

/* ------------------------------------------------------------------------- *
 * Email composition (pure — unit-tested in scripts/dev-tests)
 * ------------------------------------------------------------------------- */

export interface AlertEmailInput {
  shop: string;
  review: Pick<
    Review,
    | "id"
    | "productId"
    | "productTitle"
    | "productHandle"
    | "rating"
    | "title"
    | "body"
    | "language"
    | "authorName"
    | "authorEmail"
    | "customerId"
    | "variantTitle"
    | "verified"
    | "status"
    | "ageRange"
    | "skinConcerns"
    | "timeUsing"
    | "resultsSeen"
    | "createdAt"
  >;
  context: OrderContext;
  mediaCount: number;
  thresholdMax: number;
  isTest?: boolean;
}

export interface AlertEmail {
  subject: string;
  text: string;
  html: string;
}

/** Collapse header-hostile characters — never let user text break out of a header line. */
export function oneLine(value: string, max = 200): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stars(rating: number): string {
  const r = Math.min(5, Math.max(0, Math.round(rating)));
  return "★".repeat(r) + "☆".repeat(5 - r);
}

function fmtInstant(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function storeSlug(shop: string): string {
  return shop.replace(/\.myshopify\.com$/i, "");
}

function adminUrl(shop: string, path: string): string {
  return `https://admin.shopify.com/store/${storeSlug(shop)}${path}`;
}

/**
 * Build the alert email (subject + text + HTML). Pure and deterministic so the
 * dev-test suite can pin escaping, honesty rules and structure.
 */
export function buildAlertEmail(input: AlertEmailInput): AlertEmail {
  const { review, context, shop } = input;
  const productLabel = review.productTitle || `Product ${review.productId}`;
  const statusLine =
    review.status === "PUBLISHED"
      ? "Published — visible to shoppers (auto-publish is on)"
      : "Pending moderation — NOT visible to shoppers yet";

  const subject = oneLine(
    `${input.isTest ? "[TEST] " : ""}[Cellexia Reviews] ${review.rating}-star review — ` +
      `${productLabel} — ${review.authorName}`,
  );

  const attrs: Array<[string, string]> = [];
  const age = labelFor(review.ageRange, AGE_RANGE_LABELS);
  if (age) attrs.push(["Age range", age]);
  const time = labelFor(review.timeUsing, TIME_USING_LABELS);
  if (time) attrs.push(["Time using", time]);
  const concerns = labelsFor(parseKeyArray(review.skinConcerns), SKIN_CONCERN_LABELS);
  if (concerns.length) attrs.push(["Concerns", concerns.join(", ")]);
  const results = labelsFor(parseKeyArray(review.resultsSeen), RESULTS_SEEN_LABELS);
  if (results.length) attrs.push(["Results seen", results.join(", ")]);
  if (review.variantTitle) attrs.push(["Variant", review.variantTitle]);
  attrs.push(["Language", labelFor(review.language, LOCALE_LABELS) ?? review.language]);
  if (input.mediaCount > 0) {
    attrs.push([
      "Media",
      `${input.mediaCount} attachment${input.mediaCount === 1 ? "" : "s"} — view in the app's Reviews screen`,
    ]);
  }

  const customer = context.customer;
  // The third element marks the ONE row whose value the app itself built and
  // may render as a hyperlink. Never derived from the value's shape: a shopper
  // controls authorName/authorEmail (EMAIL_RE accepts "https://…#@x.com"), and
  // a URL-looking value must render as inert text, not a clickable phishing
  // link inside a trusted alert.
  const customerLines: Array<[string, string] | [string, string, "admin-link"]> = [
    ["Name", review.authorName],
    ["Email", review.authorEmail ?? "—"],
  ];
  if (customer?.displayName && customer.displayName !== review.authorName) {
    customerLines.push(["Shopify customer", customer.displayName]);
  }
  if (customer?.phone) customerLines.push(["Phone", customer.phone]);
  if (customer?.ordersCount) customerLines.push(["Total orders", customer.ordersCount]);
  const customerId = customer?.id ?? (review.customerId ? String(review.customerId).replace(/\D/g, "") : "");
  if (customerId) {
    customerLines.push(["Customer admin page", adminUrl(shop, `/customers/${customerId}`), "admin-link"]);
  }

  const ordersIntro =
    context.status === "unavailable"
      ? "Order lookup was unavailable (no Shopify API session) — check the customer in the Shopify admin."
      : context.status === "failed"
        ? "The order lookup FAILED (Shopify did not answer) — the customer may still have orders; check the Shopify admin."
        : context.orders.length === 0
          ? "No orders were found for this customer (searched by customer id and email)."
          : `${context.orders.length} recent order${context.orders.length === 1 ? "" : "s"} (newest first):`;

  // ----- text part ---------------------------------------------------------
  const t: string[] = [];
  if (input.isTest) {
    t.push("THIS IS A TEST ALERT sent from Cellexia Reviews → Settings — no shopper wrote this review.");
    t.push("");
  }
  t.push(`${stars(review.rating)}  ${review.rating}/5 — ${productLabel}`);
  t.push(`Status: ${statusLine}`);
  t.push(`Submitted: ${fmtInstant(review.createdAt)}`);
  t.push(`Verified purchase: ${review.verified ? "yes" : "no"}`);
  t.push("");
  t.push(`Review by ${review.authorName}${review.title ? ` — “${review.title}”` : ""}`);
  t.push("-".repeat(40));
  t.push(review.body);
  t.push("-".repeat(40));
  for (const [k, v] of attrs) t.push(`${k}: ${v}`);
  t.push("");
  t.push("CUSTOMER");
  for (const [k, v] of customerLines) t.push(`${k}: ${v}`);
  t.push("");
  t.push("ORDERS");
  t.push(ordersIntro);
  for (const order of context.orders) {
    const marker = order.containsReviewedProduct ? "  ← contains the reviewed product" : "";
    t.push("");
    t.push(
      `${order.name} — ${fmtInstant(order.createdAt)}${order.total ? ` — ${order.total}` : ""}` +
        `${order.fulfillment ? ` — ${order.fulfillment}` : ""}` +
        `${order.financial ? ` — ${order.financial}` : ""}${marker}`,
    );
    for (const item of order.items) {
      t.push(
        `  ${item.quantity} × ${item.title}${item.variantTitle ? ` (${item.variantTitle})` : ""}` +
          `${item.isReviewedProduct ? "  ← reviewed product" : ""}`,
      );
    }
    if (order.id) t.push(`  ${adminUrl(shop, `/orders/${order.id}`)}`);
  }
  t.push("");
  // The test send carries no Reply-To header (there is no real customer), so
  // its copy must not claim one is set.
  t.push(
    input.isTest
      ? "In a real alert, Reply-To is set to the reviewer — replying writes directly to the customer."
      : `Reply to this email to write directly to the customer (Reply-To is set to ${review.authorEmail ?? "the reviewer"}).`,
  );
  t.push(
    `You are receiving this because Low-star review alerts (≤ ${input.thresholdMax} stars) are enabled in Cellexia Reviews → Settings.`,
  );

  // ----- HTML part ---------------------------------------------------------
  // Only rows explicitly tagged "admin-link" (values the code itself built
  // via adminUrl) become hyperlinks — and only when they really point at the
  // Shopify admin. Everything else renders as escaped inert text.
  const rows = (pairs: Array<[string, string] | [string, string, "admin-link"]>) =>
    pairs
      .map(([k, v, tag]) => {
        const value =
          tag === "admin-link" && v.startsWith("https://admin.shopify.com/")
            ? `<a href="${esc(v)}">${esc(v)}</a>`
            : esc(v);
        return `<tr><td style="padding:2px 12px 2px 0;color:#6b7177;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:2px 0;">${value}</td></tr>`;
      })
      .join("");

  const orderBlocks = context.orders
    .map((order) => {
      const items = order.items
        .map(
          (item) =>
            `<li>${esc(String(item.quantity))} × ${esc(item.title)}${
              item.variantTitle ? ` <span style="color:#6b7177;">(${esc(item.variantTitle)})</span>` : ""
            }${item.isReviewedProduct ? ' <strong style="color:#b45309;">← reviewed product</strong>' : ""}</li>`,
        )
        .join("");
      return `<div style="margin:10px 0;padding:10px 12px;border:1px solid #e3e5e7;border-radius:8px;">
        <div><strong>${esc(order.name)}</strong> — ${esc(fmtInstant(order.createdAt))}${
          order.total ? ` — ${esc(order.total)}` : ""
        }${order.fulfillment ? ` — ${esc(order.fulfillment)}` : ""}${
          order.financial ? ` — ${esc(order.financial)}` : ""
        }${
          order.containsReviewedProduct
            ? ' <strong style="color:#b45309;">contains the reviewed product</strong>'
            : ""
        }</div>
        <ul style="margin:6px 0 6px 18px;padding:0;">${items}</ul>
        ${order.id ? `<a href="${esc(adminUrl(shop, `/orders/${order.id}`))}">Open order in Shopify admin</a>` : ""}
      </div>`;
    })
    .join("");

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1c1d;max-width:640px;">
  ${
    input.isTest
      ? '<p style="padding:8px 12px;background:#fff4e4;border:1px solid #e0b878;border-radius:8px;"><strong>This is a test alert</strong> sent from Cellexia Reviews → Settings — no shopper wrote this review.</p>'
      : ""
  }
  <h2 style="margin:0 0 4px;font-size:18px;">
    <span style="color:#b45309;">${esc(stars(review.rating))}</span>
    ${esc(String(review.rating))}/5 — ${esc(productLabel)}
  </h2>
  <p style="margin:0 0 12px;color:${review.status === "PUBLISHED" ? "#8a3ffc" : "#6b7177"};">${esc(statusLine)}</p>
  <div style="padding:12px 14px;background:#f6f6f7;border-radius:8px;margin-bottom:14px;">
    <div style="margin-bottom:6px;"><strong>${esc(review.authorName)}</strong>${
      review.verified ? ' <span style="color:#c45500;font-weight:700;">Verified Purchase</span>' : ""
    } · ${esc(fmtInstant(review.createdAt))}</div>
    ${review.title ? `<div style="font-weight:600;margin-bottom:4px;">${esc(review.title)}</div>` : ""}
    <div style="white-space:pre-wrap;">${esc(review.body)}</div>
  </div>
  <table style="border-collapse:collapse;margin-bottom:14px;">${rows(attrs)}</table>
  <h3 style="margin:0 0 6px;font-size:15px;">Customer</h3>
  <table style="border-collapse:collapse;margin-bottom:14px;">${rows(customerLines)}</table>
  <h3 style="margin:0 0 6px;font-size:15px;">Orders</h3>
  <p style="margin:0 0 6px;">${esc(ordersIntro)}</p>
  ${orderBlocks}
  <p style="margin:14px 0 0;color:#6b7177;font-size:12px;">
    ${
      input.isTest
        ? "In a real alert, Reply-To is set to the reviewer — replying writes directly to the customer."
        : "Reply to this email to write directly to the customer (Reply-To is set to the reviewer's address)."
    }<br>
    You are receiving this because Low-star review alerts (≤ ${esc(String(input.thresholdMax))} stars)
    are enabled in Cellexia Reviews → Settings — turn them off there any time.
  </p>
</div>`;

  return { subject, text: t.join("\n"), html };
}

/* ------------------------------------------------------------------------- *
 * Transport + outcome recording
 * ------------------------------------------------------------------------- */

function createTransport(config: SmtpConfig) {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.security === "tls",
    requireTLS: config.security === "starttls",
    ignoreTLS: config.security === "none",
    auth: config.user ? { user: config.user, pass: config.pass ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export type SendOutcome =
  | { status: "sent"; recipients?: string[] }
  | { status: "not_configured"; reason: SmtpConfigError | "no_recipients" }
  // The alert was deliberately not attempted (per-shop cap). Distinct from
  // send_failed so the recorded reason never claims an SMTP failure that
  // never happened.
  | { status: "dropped"; detail: string }
  | { status: "send_failed"; detail: string };

async function deliver(
  settings: Setting,
  email: AlertEmail,
  recipients: string[],
  replyTo: { name: string; address: string } | undefined,
): Promise<SendOutcome> {
  const config = resolveSmtpConfig(settings);
  if (typeof config === "string") return { status: "not_configured", reason: config };
  if (recipients.length === 0) return { status: "not_configured", reason: "no_recipients" };
  try {
    const transport = createTransport(config);
    await transport.sendMail({
      from: { name: "Cellexia Reviews", address: config.from },
      to: recipients,
      replyTo,
      subject: email.subject,
      text: email.text,
      html: email.html,
    });
    return { status: "sent" };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX);
    return { status: "send_failed", detail };
  }
}

/** Record the outcome on the Setting row (lastSyncError pattern). */
async function recordOutcome(shop: string, outcome: SendOutcome): Promise<void> {
  try {
    if (outcome.status === "sent") {
      await prisma.setting.update({
        where: { shop },
        data: { lastAlertAt: new Date(), lastAlertError: null },
      });
    } else {
      const message =
        outcome.status === "dropped"
          ? outcome.detail
          : outcome.status === "send_failed"
            ? `SMTP send failed: ${outcome.detail}`
            : outcome.reason === "no_host"
              ? "No SMTP host configured"
              : outcome.reason === "no_from"
                ? "No From address (set one, or use an email address as the SMTP username)"
                : "No recipients configured";
      await prisma.setting.update({
        where: { shop },
        data: { lastAlertError: message.slice(0, ERROR_MAX) },
      });
    }
  } catch (error) {
    console.error("[cellexia] recording alert outcome failed", error);
  }
}

/* ------------------------------------------------------------------------- *
 * Entry points
 * ------------------------------------------------------------------------- */

/**
 * Fire-and-forget entry called after a storefront review is created. Reads
 * the settings itself, applies the gate, collects order context, sends, and
 * records the outcome. NEVER throws.
 */
export async function maybeSendLowStarAlert(
  shop: string,
  review: Review,
  admin: AdminClient | null,
  opts: { mediaCount?: number } = {},
): Promise<void> {
  try {
    const settings = await getSettings(shop);
    if (!shouldAlert(settings, review)) return;

    // Per-shop hourly cap: the submit rate limit is per-IP, so a distributed
    // bot could otherwise turn the support inbox into the victim. Dropped
    // alerts are logged AND recorded on the row — the reviews themselves are
    // safely in moderation either way.
    if (!checkRateLimit(shop, "shop", "alert")) {
      console.error(`[cellexia] low-star alert dropped (per-shop hourly cap) for ${shop}`);
      // No claim about the review's status here: with auto-publish on it is
      // already live, not "in moderation".
      await recordOutcome(shop, {
        status: "dropped",
        detail:
          "Hourly alert cap reached (30 per hour) — this alert email was not sent. The review itself was saved normally. Nothing is wrong with your email settings.",
      });
      return;
    }

    const context = await collectOrderContext(admin, review);
    const email = buildAlertEmail({
      shop,
      review,
      context,
      mediaCount: opts.mediaCount ?? 0,
      thresholdMax: clampThreshold(settings.lowStarAlertMax),
    });
    const replyTo = review.authorEmail
      ? { name: oneLine(review.authorName, 80), address: review.authorEmail }
      : undefined;
    const outcome = await deliver(settings, email, effectiveRecipients(settings), replyTo);
    if (outcome.status !== "sent") {
      console.error("[cellexia] low-star alert not sent", outcome);
    }
    await recordOutcome(shop, outcome);
  } catch (error) {
    // Alerting must never surface into the submission path.
    console.error("[cellexia] maybeSendLowStarAlert failed", error);
  }
}

/**
 * "Send test email" from Settings. `candidate` is the EXACT Setting row the
 * route computed by applying the SAVE-path sanitizers to the current form
 * values (SPEC-1.34 §5) — so the test exercises precisely the configuration a
 * Save would persist, never a third variant. The route also resolves the two
 * special rules there (blank password keeps the saved one only while the host
 * is unchanged; the typed Notification email participates in the recipient
 * fallback). Sends a clearly marked sample alert. Outcome recording is the
 * ROUTE's decision: only a test of the currently SAVED configuration may
 * clear lastAlertError (clearAlertError below), and a test never stamps
 * lastAlertAt — that timestamp means "a real alert was sent".
 */
export async function sendTestAlert(
  shop: string,
  candidate: Setting,
): Promise<SendOutcome> {
  const thresholdMax = clampThreshold(candidate.lowStarAlertMax);

  const now = new Date();
  const sample: AlertEmailInput["review"] = {
    id: "test",
    productId: "0",
    productTitle: "Sample product (test)",
    productHandle: null,
    rating: 1,
    title: "Sample low-star review",
    body:
      "This is what a low-star alert looks like. A real alert contains the shopper's full review text here, " +
      "with their contact details and recent orders below.",
    language: "en",
    authorName: "Test Shopper",
    authorEmail: "shopper@example.com",
    customerId: null,
    variantTitle: null,
    verified: true,
    status: "PENDING",
    ageRange: null,
    skinConcerns: "[]",
    timeUsing: null,
    resultsSeen: "[]",
    createdAt: now,
  };
  const email = buildAlertEmail({
    shop,
    review: sample,
    context: {
      status: "ok",
      orders: [
        {
          id: "",
          name: "#0000 (sample)",
          createdAt: now.toISOString(),
          fulfillment: "FULFILLED",
          financial: "PAID",
          total: "0.00",
          items: [
            { title: "Sample product (test)", quantity: 1, variantTitle: null, isReviewedProduct: true },
          ],
          containsReviewedProduct: true,
        },
      ],
      customer: null,
    },
    mediaCount: 0,
    thresholdMax,
    isTest: true,
  });

  const recipients = effectiveRecipients(candidate);
  const outcome = await deliver(candidate, email, recipients, undefined);
  return outcome.status === "sent" ? { status: "sent", recipients } : outcome;
}

/**
 * Clear the recorded failure reason WITHOUT touching lastAlertAt. Called by
 * the Settings test intent only when a test succeeded with the SAVED
 * configuration — a green test of unsaved values proves nothing about the
 * saved row, so it must not hide that row's failure banner.
 */
export async function clearAlertError(shop: string): Promise<void> {
  try {
    await prisma.setting.update({ where: { shop }, data: { lastAlertError: null } });
  } catch (error) {
    console.error("[cellexia] clearing alert error failed", error);
  }
}
