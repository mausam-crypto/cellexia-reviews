import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import type { CSSProperties } from "react";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

const styles = {
  index: {
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
    minHeight: "100vh",
    padding: "2rem",
    background: "#f6f6f7",
    color: "#202223",
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
  },
  content: {
    width: "100%",
    maxWidth: "28rem",
    background: "#ffffff",
    border: "1px solid #e1e3e5",
    borderRadius: "12px",
    padding: "2.5rem",
    boxShadow: "0 1px 3px rgba(0, 0, 0, 0.08)",
  },
  heading: {
    margin: "0 0 0.5rem",
    fontSize: "1.5rem",
    fontWeight: 700,
  },
  text: {
    margin: "0 0 1.5rem",
    color: "#6d7175",
    lineHeight: 1.5,
  },
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "0.75rem",
    marginBottom: "1.5rem",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
    fontSize: "0.875rem",
    fontWeight: 600,
  },
  input: {
    padding: "0.625rem 0.75rem",
    border: "1px solid #8c9196",
    borderRadius: "8px",
    fontSize: "0.9375rem",
  },
  hint: {
    fontWeight: 400,
    color: "#6d7175",
    fontSize: "0.8125rem",
  },
  button: {
    padding: "0.625rem 1rem",
    background: "#1a1a1a",
    color: "#ffffff",
    border: "none",
    borderRadius: "8px",
    fontSize: "0.9375rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  list: {
    margin: 0,
    paddingLeft: "1.25rem",
    color: "#454749",
    lineHeight: 1.7,
    fontSize: "0.875rem",
  },
} satisfies Record<string, CSSProperties>;

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div style={styles.index}>
      <div style={styles.content}>
        <h1 style={styles.heading}>Cellexia Reviews</h1>
        <p style={styles.text}>
          Amazon-grade product reviews for the Cellexia storefront — moderated
        in your Shopify admin, rendered instantly on your product pages.
        </p>
        {showForm && (
          <Form style={styles.form} method="post" action="/auth/login">
            <label style={styles.label}>
              <span>Shop domain</span>
              <input style={styles.input} type="text" name="shop" />
              <span style={styles.hint}>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button style={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul style={styles.list}>
          <li>
            Star ratings, photo and video reviews, helpful votes and brand
            replies — with SEO-ready rich snippets.
          </li>
          <li>
            AI review summaries and topic chips, plus on-demand review
            translation powered by Claude.
          </li>
          <li>
            17 storefront languages out of the box, added as a theme app block —
            no theme code edits.
          </li>
        </ul>
      </div>
    </div>
  );
}
