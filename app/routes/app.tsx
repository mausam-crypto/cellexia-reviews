import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
// Side-effect import: the Remix Vite plugin bundles this stylesheet and links
// it for every /app route. (A `?url` import trips a vite 6 css-post bug here.)
import "@shopify/polaris/build/esm/styles.css";

import { authenticate } from "~/shopify.server";
import { kickRunner } from "~/services/jobs.server";
import { GenerationActivityBar } from "~/components/admin/GenerationActivityBar";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  // Every admin page renders the generation activity bar, so every admin
  // loader keeps the background job runner alive (SPEC-1.7 §3 — kickRunner is
  // idempotent and cheap). A runner hiccup must never block the admin.
  try {
    kickRunner();
  } catch (error) {
    console.error("[cellexia] app loader kickRunner failed", error);
  }
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          Dashboard
        </Link>
        <Link to="/app/reviews">Reviews</Link>
        <Link to="/app/display">Display order</Link>
        <Link to="/app/reviews-page">Reviews page</Link>
        <Link to="/app/bulk-add">Bulk add</Link>
        <Link to="/app/import-export">Import / Export</Link>
        <Link to="/app/qa-generator">QA data</Link>
        <Link to="/app/settings">Settings</Link>
      </NavMenu>
      {/* Global generation progress — visible on every admin page while ≥ 1
          background job is active (SPEC-1.7 §5). */}
      <GenerationActivityBar />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
