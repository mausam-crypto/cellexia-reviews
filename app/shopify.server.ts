import "dotenv/config";
import "@shopify/shopify-app-remix/adapters/node";
import {
  AppDistribution,
  LATEST_API_VERSION,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import {
  ensureMetafieldDefinitions,
  syncShopSettingsMetafields,
} from "~/services/metafields.server";
import { getSettings } from "~/services/settings.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: LATEST_API_VERSION,
  scopes: process.env.SCOPES?.split(","),
  // Falls back to Render's auto-provided service URL so the app can boot
  // on a fresh deploy before SHOPIFY_APP_URL is manually set.
  appUrl: process.env.SHOPIFY_APP_URL || process.env.RENDER_EXTERNAL_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.SingleMerchant,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
    removeRest: true,
  },
  hooks: {
    afterAuth: async ({ session, admin }) => {
      shopify.registerWebhooks({ session });
      try {
        await ensureMetafieldDefinitions(admin);
        // SPEC-1.2: sync the SHOP settings metafields at install/re-auth. New
        // shops get `cellexia.live=false` (safe install — no visible change
        // until the merchant goes live) plus the defaults; re-authed existing
        // shops re-sync their true current state.
        const settings = await getSettings(session.shop);
        await syncShopSettingsMetafields(admin, settings);
      } catch (error) {
        // Metafield definitions/sync are re-attempted on the next auth; never
        // block the OAuth callback on this.
        console.error("ensureMetafieldDefinitions failed:", error);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = LATEST_API_VERSION;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
