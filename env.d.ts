/// <reference types="vite/client" />
/// <reference types="@remix-run/node" />

declare namespace NodeJS {
  interface ProcessEnv {
    /** Client ID of the app from the Partner Dashboard. */
    SHOPIFY_API_KEY?: string;
    /** Client secret of the app — also used to verify app-proxy signatures. */
    SHOPIFY_API_SECRET?: string;
    /** Public HTTPS URL where this backend is reachable. */
    SHOPIFY_APP_URL?: string;
    /** Comma-separated OAuth scopes. */
    SCOPES?: string;
    /** Only used when prisma/schema.prisma is switched to env("DATABASE_URL"). */
    DATABASE_URL?: string;
    /** Local dev/demo only: accept unsigned app-proxy requests when "1". */
    CELLEXIA_ALLOW_UNSIGNED?: string;
    /** Optional custom shop domain allowed by the auth layer. */
    SHOP_CUSTOM_DOMAIN?: string;
    /** Injected by the Shopify CLI during `npm run dev`. */
    FRONTEND_PORT?: string;
    PORT?: string;
    HOST?: string;
  }
}
