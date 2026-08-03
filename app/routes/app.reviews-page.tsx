/**
 * "Reviews page" admin (SPEC-1.19 §10).
 *
 * The setup and control surface for the public "Cellexia Reviews" brand page
 * at /pages/cellexia-reviews:
 *  - Setup checklist card: ① create the Shopify page (Admin API pageCreate,
 *    degrading to exact manual steps when the scope is missing; the returned
 *    handle is verified, and SEO title/description are merchant-pasted
 *    because PageCreateInput carries no SEO field), ② create a dedicated
 *    `cellexia-reviews` page template and add the app section to THAT
 *    template — never to the shared "Default page" one (always a manual
 *    step), ③ generate the AI review analysis (per-shop 10-minute debounce
 *    cleared on any failure; a successful generate auto-publishes and the
 *    generated sections are shown here for review), ④ publish the
 *    `cellexia.brand_page` shop metafield the section SSRs from, with its
 *    `publishedAt` read back from the live metafield, ⑤ robots.txt /
 *    navigation / sitemap guidance so search engines and AI assistants can
 *    read the page.
 *  - Interactive-features card: the ask / recommend toggles persisted to
 *    Setting.brandPageConfig — progressive extras only, every review and
 *    summary stays server-rendered regardless (SPEC-1.19 §9).
 *  - "What's on the page" card: nothing hidden — exactly what is SSR'd, what
 *    the AI wrote vs what the app computed, and that synthetic QA reviews
 *    are ALWAYS excluded from this surface (SPEC-1.19 §10).
 */
import { useState } from "react";
import type { ReactNode } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Collapsible,
  Divider,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { getSettings } from "~/services/settings.server";
import {
  ANALYSIS_SECTION_KEYS,
  computeBrandPageFacts,
  parseBrandPageConfig,
} from "~/services/brand-page.server";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, formatDateTime, pluralize } from "~/components/admin/labels";

/** Exact handle the brand page must live at (SPEC-1.19 §1). */
const PAGE_HANDLE = "cellexia-reviews";

/**
 * Recommended SEO strings for the page. `PageCreateInput` carries no SEO
 * field in the Admin API version this app pins (2025-07 / LATEST_API_VERSION
 * — fields are body, handle, isPublished, metafields, publishDate,
 * templateSuffix, title), so the mutation cannot set them and step 1 tells
 * the merchant exactly what to paste in "Edit website SEO" instead.
 */
const SEO_TITLE = "Cellexia Reviews — Real Customer Reviews & Ratings";
const SEO_DESCRIPTION =
  "Read verified Cellexia reviews from real customers: ratings, results, skin concerns and honest feedback, with the full review archive.";

/**
 * Human-readable titles for the five analysis sections — the same questions
 * the storefront section renders as its FAQ (locale keys brand_page.q_*).
 */
const SECTION_TITLES: Record<string, string> = {
  positive: "Are Cellexia reviews positive?",
  results: "What results do customers report?",
  complaints: "What do critical reviews say?",
  byConcern: "Which product is best for each skin concern?",
  timeline: "How long do results take?",
};

interface AnalysisSectionSummary {
  key: string;
  title: string;
  prose: string;
  quoteCount: number;
}

/**
 * Parses the stored `BrandAnalysis.sections` JSON for the admin review panel
 * (SPEC-1.19 §10: the generated sections are shown for review with quote
 * counts). Defensive on purpose — a malformed row must not break the screen.
 */
function parseAnalysisSections(raw: string | null | undefined): AnalysisSectionSummary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as {
      sections?: Record<string, { prose?: unknown; quotes?: unknown } | undefined>;
    } | null;
    const sections = parsed?.sections;
    if (!sections || typeof sections !== "object") return [];
    const out: AnalysisSectionSummary[] = [];
    for (const key of ANALYSIS_SECTION_KEYS) {
      const section = sections[key];
      const prose = typeof section?.prose === "string" ? section.prose.trim() : "";
      if (!prose) continue;
      out.push({
        key,
        title: SECTION_TITLES[key] ?? key,
        prose,
        quoteCount: Array.isArray(section?.quotes) ? section.quotes.length : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Per-shop debounce for "generate-analysis" (SPEC-1.19 §10: regenerate
 * allowed, 10-min debounce). Same in-process pattern + caveats as the
 * curation debounceMap: per process, cleared on failure so a failed run is
 * retryable right away.
 */
const ANALYSIS_DEBOUNCE_MS = 10 * 60 * 1000;
const analysisDebounce = new Map<string, number>();

const PAGE_LOOKUP_QUERY = `#graphql
  query CellexiaReviewsPageLookup {
    pages(first: 25, query: "handle:${PAGE_HANDLE}") {
      nodes { id handle }
    }
  }
`;

/**
 * `templateSuffix` is deliberately NOT set: the merchant creates the
 * `cellexia-reviews` page template from the theme editor (step 2), and that
 * flow assigns the new template to this page itself. Setting a suffix here
 * would point the page at a template that does not exist yet.
 */
const PAGE_CREATE_MUTATION = `#graphql
  mutation CellexiaReviewsPageCreate {
    pageCreate(
      page: {
        title: "Cellexia Reviews"
        handle: "${PAGE_HANDLE}"
        isPublished: true
        body: ""
      }
    ) {
      page { id handle }
      userErrors { field message }
    }
  }
`;

/** Reads the published `cellexia.brand_page` payload so step 4 can show when
 *  the page data was last published (SPEC-1.19 §10). */
const BRAND_PAGE_METAFIELD_QUERY = `#graphql
  query CellexiaBrandPagePublished {
    shop {
      metafield(namespace: "cellexia", key: "brand_page") { value }
    }
  }
`;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  // computeBrandPageFacts scans every published, non-synthetic review row for
  // this shop on each load. That full scan is intentional here: it is the same
  // computation the published page uses, this is a low-traffic admin screen,
  // and a stale cached copy would make the "Current stats" line dishonest.
  const [settings, analysisRow, facts] = await Promise.all([
    getSettings(shop),
    prisma.brandAnalysis.findUnique({ where: { shop } }),
    computeBrandPageFacts(shop),
  ]);

  // Page existence check — best-effort only. Older API versions may not have
  // the `pages` query and the scope may be missing, so ANY error degrades to
  // "unknown" (the checklist then shows the manual steps); never throw.
  let pageStatus: "exists" | "missing" | "unknown" = "unknown";
  try {
    const response = await admin.graphql(PAGE_LOOKUP_QUERY);
    const body = (await response.json()) as {
      data?: { pages?: { nodes?: Array<{ id?: string; handle?: string }> } };
      errors?: unknown;
    };
    if (!body.errors && body.data?.pages?.nodes) {
      pageStatus = body.data.pages.nodes.some((node) => node.handle === PAGE_HANDLE)
        ? "exists"
        : "missing";
    }
  } catch (error) {
    console.error("[cellexia] reviews-page lookup failed", error);
  }

  // When the page data was last published — read straight from the live
  // metafield so step 4 reports what the storefront actually has, not what we
  // think we wrote. Any failure (missing metafield, missing scope, bad JSON)
  // degrades to null → "Never published".
  let publishedAt: string | null = null;
  try {
    const response = await admin.graphql(BRAND_PAGE_METAFIELD_QUERY);
    const body = (await response.json()) as {
      data?: { shop?: { metafield?: { value?: string | null } | null } | null };
      errors?: unknown;
    };
    const raw = body.errors ? null : body.data?.shop?.metafield?.value;
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = JSON.parse(raw) as { publishedAt?: unknown };
      if (typeof parsed?.publishedAt === "string" && parsed.publishedAt.length > 0) {
        publishedAt = parsed.publishedAt;
      }
    }
  } catch (error) {
    console.error("[cellexia] brand_page metafield read failed", error);
  }

  return json({
    config: parseBrandPageConfig(settings.brandPageConfig),
    analysis: analysisRow
      ? {
          generatedAt: analysisRow.generatedAt,
          reviewCount: analysisRow.reviewCount,
          model: analysisRow.model,
        }
      : null,
    // The generated prose + per-section quote counts, so the merchant can read
    // what was published instead of trusting it sight-unseen (SPEC-1.19 §10).
    analysisSections: parseAnalysisSections(analysisRow?.sections),
    publishedAt,
    // Status summary only — never the whole facts object (bodies, quotes and
    // per-product tables have no business in this loader's payload).
    facts: {
      count: facts.count,
      average: facts.average,
      criticalCount: facts.criticalCount,
      products: facts.products.length,
    },
    pageStatus,
    // Display-only hint for the archive URL in the checklist. Setting
    // .proxySubpath is the install's detected app-proxy subpath (SPEC-1.6 §2).
    proxySubpath: settings.proxySubpath || "cellexia-reviews",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "create-page") {
      const manualFallback =
        'Could not create the page automatically (the app may lack the write_online_store_pages scope). Create it manually: Online Store → Pages → Add page, title "Cellexia Reviews", make sure the handle is exactly cellexia-reviews.';
      let createdHandle = "";
      try {
        const response = await admin.graphql(PAGE_CREATE_MUTATION);
        const body = (await response.json()) as {
          data?: {
            pageCreate?: {
              page?: { id?: string; handle?: string } | null;
              userErrors?: Array<{ field?: string[] | null; message?: string }>;
            };
          };
          errors?: unknown;
        };
        const userErrors = body.data?.pageCreate?.userErrors ?? [];
        if (body.errors || userErrors.length > 0 || !body.data?.pageCreate?.page) {
          console.error(
            "[cellexia] pageCreate failed",
            body.errors ?? userErrors,
          );
          return json({ ok: false, message: manualFallback }, { status: 400 });
        }
        createdHandle = body.data.pageCreate.page.handle ?? "";
      } catch (error) {
        console.error("[cellexia] pageCreate threw", error);
        return json({ ok: false, message: manualFallback }, { status: 400 });
      }
      // Shopify silently auto-suffixes a handle that is already taken
      // (cellexia-reviews-1, -2, …). Never report the wanted URL without
      // checking what we actually got back.
      if (createdHandle !== PAGE_HANDLE) {
        console.error("[cellexia] pageCreate returned handle", createdHandle);
        return json(
          {
            ok: false,
            message: createdHandle
              ? `The page was created, but at /pages/${createdHandle} — not /pages/${PAGE_HANDLE}. Another page already uses the ${PAGE_HANDLE} handle, so Shopify added a suffix. Delete or rename that other page and press Create again, or use /pages/${createdHandle} instead (the section works there, but it is not the URL this app links to).`
              : `The page was created, but Shopify did not return its handle, so we cannot confirm it lives at /pages/${PAGE_HANDLE}. Check Online Store → Pages before continuing.`,
          },
          { status: 400 },
        );
      }
      return json({
        ok: true,
        message: `Page created at /pages/${PAGE_HANDLE}. Next: set its SEO title and description (step 1), then add the app section in the theme editor (step 2).`,
      });
    }

    if (intent === "generate-analysis") {
      const now = Date.now();
      if ((analysisDebounce.get(shop) ?? 0) > now - ANALYSIS_DEBOUNCE_MS) {
        return json(
          {
            ok: false,
            message:
              "The analysis was generated less than 10 minutes ago — try again later.",
          },
          { status: 400 },
        );
      }
      analysisDebounce.set(shop, now);
      let generated = false;
      try {
        const { generateBrandAnalysis, publishBrandPage } = await import(
          "~/services/brand-page.server"
        );
        const result = await generateBrandAnalysis(shop);
        if (result.status !== "ok") {
          const message =
            result.status === "no_ai"
              ? "No Claude API key configured — add one in Settings first."
              : result.status === "no_reviews"
                ? "No published customer reviews yet — the analysis needs at least one published, non-synthetic review."
                : "The AI call failed — try again in a minute.";
          return json({ ok: false, message }, { status: 400 });
        }
        generated = true;
        const published = await publishBrandPage(shop, admin);
        return json({
          ok: true,
          message: published
            ? `Analysis generated over ${result.reviewCount} reviews and published — read the five sections under step 3 to review what went live.`
            : `Analysis generated over ${result.reviewCount} reviews and shown under step 3, but publishing the page data failed — press "Publish now" (step 4) to retry.`,
        });
      } finally {
        // A failed OR thrown run must be retryable right away — the debounce
        // only guards genuinely successful generations (same rule as the
        // curation queue). Without this, one transient error would lock the
        // merchant out for 10 minutes.
        if (!generated) analysisDebounce.delete(shop);
      }
    }

    if (intent === "publish-data") {
      const { publishBrandPage } = await import("~/services/brand-page.server");
      const published = await publishBrandPage(shop, admin);
      if (!published) {
        return json(
          {
            ok: false,
            message: "Publishing the page data failed — try again in a minute.",
          },
          { status: 500 },
        );
      }
      return json({
        ok: true,
        message: "Page data published — the page updates within a couple of minutes.",
      });
    }

    if (intent === "save-config") {
      const ask = String(form.get("ask") ?? "") === "true";
      const recommend = String(form.get("recommend") ?? "") === "true";
      const { updateSettings } = await import("~/services/settings.server");
      await updateSettings(shop, {
        brandPageConfig: JSON.stringify({ ask, recommend }),
      });
      // The toggles ship inside the published metafield payload — republish
      // right away so the page reflects them within minutes, not on the next
      // manual publish.
      const { publishBrandPage } = await import("~/services/brand-page.server");
      const published = await publishBrandPage(shop, admin);
      return json({
        ok: true,
        message: published
          ? "Interactive features saved and published — live on the page within a couple of minutes."
          : "Interactive features saved. Publishing the page data failed — press Publish now to retry.",
      });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Reviews page action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

/** The copy-paste robots.txt.liquid allowances (SPEC-1.19 §5). */
const ROBOTS_SNIPPET = `# Allow AI assistants and search crawlers to read the reviews page.
# NOTE: a crawler obeys ONLY its own most specific group, so each group below
# repeats Shopify's checkout/account disallows. Without them these bots would
# stop honouring the "User-agent: *" rules entirely.
User-agent: OAI-SearchBot
Allow: /
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /search

User-agent: ClaudeBot
Allow: /
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /search

User-agent: GPTBot
Allow: /
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /search

User-agent: PerplexityBot
Allow: /
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /search

User-agent: Google-Extended
Allow: /
Disallow: /cart
Disallow: /checkout
Disallow: /account
Disallow: /orders
Disallow: /search`;

/** One numbered checklist step: number + title + status/action on one line,
 * explanatory content underneath. */
function ChecklistStep({
  number,
  title,
  status,
  children,
}: {
  number: number;
  title: string;
  status?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <BlockStack gap="150">
      <InlineStack gap="200" blockAlign="center" wrap>
        <Text as="h3" variant="headingSm">
          {number}. {title}
        </Text>
        {status}
      </InlineStack>
      {children}
    </BlockStack>
  );
}

export default function ReviewsPageRoute() {
  const data = useLoaderData<typeof loader>();
  const shopify = useAppBridge();

  const pageFetcher = useFetcher<typeof action>();
  const analysisFetcher = useFetcher<typeof action>();
  const publishFetcher = useFetcher<typeof action>();
  const configFetcher = useFetcher<typeof action>();
  useResultToast(pageFetcher);
  useResultToast(analysisFetcher);
  useResultToast(publishFetcher);
  useResultToast(configFetcher);

  const [ask, setAsk] = useState(data.config.ask);
  const [recommend, setRecommend] = useState(data.config.recommend);
  const [analysisOpen, setAnalysisOpen] = useState(false);

  const creating = pageFetcher.state !== "idle";
  const generating = analysisFetcher.state !== "idle";
  const publishing = publishFetcher.state !== "idle";
  const savingConfig = configFetcher.state !== "idle";

  const copyRobots = () => {
    void navigator.clipboard.writeText(ROBOTS_SNIPPET).then(
      () => shopify.toast.show("Robots snippet copied"),
      () =>
        shopify.toast.show("Copy failed — select the text manually", {
          isError: true,
        }),
    );
  };

  const archivePath = `/apps/${data.proxySubpath}/reviews`;

  return (
    <Page
      title="Reviews page"
      subtitle="A crawlable brand-wide reviews page for shoppers, search engines and AI assistants."
    >
      <TitleBar title="Reviews page" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Setup checklist
                </Text>

                <ChecklistStep
                  number={1}
                  title="Create the page /pages/cellexia-reviews"
                  status={
                    data.pageStatus === "exists" ? (
                      <Badge tone="success">Done</Badge>
                    ) : (
                      <Button
                        onClick={() =>
                          pageFetcher.submit({ intent: "create-page" }, { method: "post" })
                        }
                        loading={creating}
                      >
                        Create the page
                      </Button>
                    )
                  }
                >
                  <BlockStack gap="150">
                    {data.pageStatus === "exists" ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        The page exists at /pages/cellexia-reviews.
                      </Text>
                    ) : (
                      <BlockStack gap="150">
                        {data.pageStatus === "unknown" ? (
                          <Banner tone="info">
                            <Text as="p" variant="bodySm">
                              We could not check whether the page already exists (the
                              check needs the Online Store pages API). If you already
                              created it, this step is done.
                            </Text>
                          </Banner>
                        ) : null}
                        <Text as="p" variant="bodySm" tone="subdued">
                          If the button fails, create the page manually: Online Store →
                          Pages → Add page, title "Cellexia Reviews", and make sure the
                          handle is exactly cellexia-reviews (Edit website SEO → URL
                          handle).
                        </Text>
                      </BlockStack>
                    )}
                    <Text as="p" variant="bodySm" tone="subdued">
                      Set the page SEO by hand — Shopify's page-create API cannot set
                      it, so the Create button does not either. Go to Online Store →
                      Pages → Cellexia Reviews → Edit website SEO and paste:
                    </Text>
                    <Box
                      background="bg-surface-secondary"
                      padding="300"
                      borderRadius="200"
                    >
                      <BlockStack gap="100">
                        <Text as="p" variant="bodySm">
                          <Text as="span" variant="bodySm" fontWeight="medium">
                            Page title:
                          </Text>{" "}
                          {SEO_TITLE}
                        </Text>
                        <Text as="p" variant="bodySm">
                          <Text as="span" variant="bodySm" fontWeight="medium">
                            Meta description:
                          </Text>{" "}
                          {SEO_DESCRIPTION}
                        </Text>
                      </BlockStack>
                    </Box>
                  </BlockStack>
                </ChecklistStep>

                <Divider />

                <ChecklistStep
                  number={2}
                  title="Add the app section on its own page template"
                  status={<Badge>Manual step</Badge>}
                >
                  <BlockStack gap="200">
                    <Banner tone="warning">
                      <Text as="p" variant="bodySm">
                        Do not add the section while "Default page" is the selected
                        template. That template is shared by every page in your store,
                        so the reviews section would show up on About, Contact and all
                        the rest. Create a dedicated template first — the steps below
                        do exactly that.
                      </Text>
                    </Banner>
                    <List type="number">
                      <List.Item>
                        Online Store → Themes → Customize.
                      </List.Item>
                      <List.Item>
                        In the dropdown at the top center, choose Pages → Cellexia
                        Reviews.
                      </List.Item>
                      <List.Item>
                        Open the template dropdown next to it (it reads "Default
                        page") and choose Create template. Name it cellexia-reviews
                        and base it on "Default page". Shopify creates the template
                        page.cellexia-reviews and opens it for editing.
                      </List.Item>
                      <List.Item>
                        With the new template open, click Add section → Apps →
                        Cellexia Reviews page, then Save.
                      </List.Item>
                      <List.Item>
                        Assign the template to the page (the theme editor does NOT
                        do this for you): Online Store → Pages → Cellexia Reviews →
                        in the "Online store" box on the right, set Theme template to
                        cellexia-reviews → Save. Without this step the page keeps
                        using the default template and the reviews section never
                        appears.
                      </List.Item>
                      <List.Item>
                        On the same Pages screen, clear the placeholder text in the
                        page body ("Loading our customer reviews…"). It was written
                        only so the page could be created; leaving it means shoppers
                        and Google read it above your reviews.
                      </List.Item>
                    </List>
                  </BlockStack>
                </ChecklistStep>

                <Divider />

                <ChecklistStep
                  number={3}
                  title="Generate the review analysis"
                  status={
                    <InlineStack gap="200" blockAlign="center" wrap>
                      {data.analysis ? <Badge tone="success">Done</Badge> : null}
                      <Button
                        onClick={() =>
                          analysisFetcher.submit(
                            { intent: "generate-analysis" },
                            { method: "post" },
                          )
                        }
                        loading={generating}
                      >
                        {data.analysis ? "Regenerate" : "Generate analysis"}
                      </Button>
                    </InlineStack>
                  }
                >
                  <BlockStack gap="100">
                    {data.analysis ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        Last generated {formatDateTime(data.analysis.generatedAt)} over{" "}
                        {pluralize(data.analysis.reviewCount, "review")}
                        {data.analysis.model ? ` · ${data.analysis.model}` : ""}.
                      </Text>
                    ) : null}
                    <Text as="p" variant="bodySm" tone="subdued">
                      Uses your Claude API key. The AI writes prose around numbers the
                      app computes itself — it never invents a number — and every quote
                      it selects is verified verbatim against the source review; failed
                      quotes are dropped.
                    </Text>
                    {data.analysisSections.length > 0 ? (
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" tone="subdued">
                          A successful generate publishes the page data straight away.
                          Read what went live below — regenerate if any of it is wrong.
                        </Text>
                        <InlineStack>
                          <Button
                            variant="plain"
                            disclosure={analysisOpen ? "up" : "down"}
                            ariaExpanded={analysisOpen}
                            ariaControls="cx-analysis-review"
                            onClick={() => setAnalysisOpen((open) => !open)}
                          >
                            {analysisOpen
                              ? "Hide the published analysis"
                              : "Review the published analysis"}
                          </Button>
                        </InlineStack>
                        <Collapsible id="cx-analysis-review" open={analysisOpen}>
                          <BlockStack gap="300">
                            {data.analysisSections.map((section) => (
                              <BlockStack gap="100" key={section.key}>
                                <Text as="h4" variant="headingXs">
                                  {section.title}
                                </Text>
                                <Text as="p" variant="bodySm">
                                  {section.prose}
                                </Text>
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {pluralize(section.quoteCount, "verified quote")}
                                </Text>
                              </BlockStack>
                            ))}
                          </BlockStack>
                        </Collapsible>
                      </BlockStack>
                    ) : null}
                  </BlockStack>
                </ChecklistStep>

                <Divider />

                <ChecklistStep
                  number={4}
                  title="Publish the page data"
                  status={
                    <InlineStack gap="200" blockAlign="center" wrap>
                      {data.publishedAt ? <Badge tone="success">Done</Badge> : null}
                      <Button
                        onClick={() =>
                          publishFetcher.submit({ intent: "publish-data" }, { method: "post" })
                        }
                        loading={publishing}
                      >
                        Publish now
                      </Button>
                    </InlineStack>
                  }
                >
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {data.publishedAt
                        ? `Last published: ${data.publishedAt}`
                        : "Never published — the page section has no data to render yet."}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Writes the facts, analysis and top reviews the page section renders
                      from. It refreshes automatically whenever your reviews change —
                      publish manually only to push an update right away.
                    </Text>
                  </BlockStack>
                </ChecklistStep>

                <Divider />

                <ChecklistStep number={5} title="Search engines & AI assistants">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      If you use a custom robots.txt.liquid, make sure these
                      user-agents are allowed. Shopify's default robots.txt already
                      allows them — only act if you added AI-bot blocking.
                    </Text>
                    <Box
                      background="bg-surface-secondary"
                      padding="300"
                      borderRadius="200"
                      overflowX="scroll"
                    >
                      <pre
                        style={{
                          margin: 0,
                          fontFamily:
                            "ui-monospace, SFMono-Regular, Menlo, monospace",
                          fontSize: "12px",
                          lineHeight: "18px",
                          whiteSpace: "pre",
                        }}
                      >
                        {ROBOTS_SNIPPET}
                      </pre>
                    </Box>
                    <InlineStack>
                      <Button onClick={copyRobots} size="slim">
                        Copy snippet
                      </Button>
                    </InlineStack>
                    <Text as="p" variant="bodySm" fontWeight="medium">
                      Where it goes
                    </Text>
                    <List type="number">
                      <List.Item>
                        Online Store → Themes → … → Edit code, then open
                        templates/robots.txt.liquid. If the file is not there, click
                        Add a new template → robots.txt — Shopify creates it
                        pre-filled with its defaults.
                      </List.Item>
                      <List.Item>
                        Leave the existing Liquid alone. The default file renders
                        Shopify's own rules from the robots object — a{" "}
                        {"{% for group in robots.default_groups %}"} loop that prints
                        each group's user_agent, rules and sitemap. Deleting it drops
                        Shopify's defaults, including the sitemap line.
                      </List.Item>
                      <List.Item>
                        Paste the snippet above after that loop, then Save.
                      </List.Item>
                      <List.Item>
                        Verify: open https://your-domain.com/robots.txt in a browser
                        and check that OAI-SearchBot, ClaudeBot, GPTBot,
                        PerplexityBot and Google-Extended all appear, and that
                        Shopify's own rules and Sitemap line are still there.
                      </List.Item>
                    </List>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Add the page to your main navigation and footer menu (Online
                      Store → Navigation) so crawlers find it through internal links.
                      The page is included in Shopify's sitemap automatically — no
                      action needed there.
                    </Text>
                  </BlockStack>
                </ChecklistStep>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Interactive features
                </Text>
                <BlockStack gap="150">
                  <Checkbox
                    label='Ask box — "Ask our reviews a question"'
                    checked={ask}
                    onChange={setAsk}
                  />
                  <Checkbox
                    label='Product recommender — "Which product is right for me?"'
                    checked={recommend}
                    onChange={setRecommend}
                  />
                  <Text as="p" variant="bodySm" tone="subdued">
                    Both are progressive extras — every review and summary on the page
                    is server-rendered regardless, so crawlers and shoppers without
                    JavaScript see the full content either way.
                  </Text>
                </BlockStack>
                <InlineStack>
                  <Button
                    variant="primary"
                    loading={savingConfig}
                    onClick={() =>
                      configFetcher.submit(
                        {
                          intent: "save-config",
                          ask: String(ask),
                          recommend: String(recommend),
                        },
                        { method: "post" },
                      )
                    }
                  >
                    Save
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  What's on the page
                </Text>
                <List type="bullet">
                  <List.Item>
                    The AI analysis sections (what customers praise, results and
                    time-to-results, common complaints, best product per skin concern)
                    — prose around app-computed numbers, with verbatim quotes.
                  </List.Item>
                  <List.Item>
                    The full star distribution — every count and percent, including
                    critical reviews.
                  </List.Item>
                  <List.Item>
                    The top ~36 reviews with skin details (concerns, age range, time
                    using, results seen), verified badges and merchant replies.
                  </List.Item>
                  <List.Item>
                    A methodology section explaining how the numbers are computed and
                    where the reviews come from.
                  </List.Item>
                  <List.Item>
                    A link to the full crawlable review archive at {archivePath}.
                  </List.Item>
                </List>
                <Text as="p" variant="bodySm" tone="subdued">
                  Honesty rules: synthetic QA reviews are ALWAYS excluded from this
                  page and its numbers, and critical reviews are always visible when
                  they exist.
                </Text>
                <Divider />
                {data.facts.count > 0 ? (
                  <Text as="p" variant="bodySm">
                    Current stats: {pluralize(data.facts.count, "published review")} ·
                    average {data.facts.average} ·{" "}
                    {pluralize(data.facts.products, "product")}
                    {data.facts.criticalCount > 0
                      ? ` · including ${pluralize(data.facts.criticalCount, "critical review")} (3★ or below)`
                      : ""}
                    .
                  </Text>
                ) : (
                  <Text as="p" variant="bodySm" tone="subdued">
                    No published customer reviews yet — the page stays minimal until
                    reviews exist.
                  </Text>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
