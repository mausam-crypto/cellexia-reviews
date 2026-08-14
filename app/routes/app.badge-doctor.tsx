/**
 * Badge doctor admin page (SPEC-1.32 §2).
 *
 * A step-by-step, leave-nothing-out diagnostic of the entire card-star
 * pipeline, so the merchant can verify each link from THEIR admin without
 * anyone touching the storefront:
 *
 *   1. Expected badge preview — before/after card-badge replicas (numeric
 *      score + inline SVG stars + count) from the top-reviewed product's REAL
 *      numbers, so the v1.32 fix is unmissable inside the admin.
 *   2. Review data — per-product published counts, averages (the exact
 *      numbers the API serves) and observed productHandle values.
 *   3. API dry-run with trace — runs the REAL badgeStatsByHandles (may reach
 *      the Admin API and, with a locale root, the storefront + shared caches)
 *      and shows, per handle, the resolution path and the exact JSON the
 *      storefront would receive.
 *   4. Live gating, 5. Rate limits — pure server reads.
 *   6. Deployed-extension check — a button; only on click does the server
 *      fetch the shop's own storefront + CDN JS and verify THE FIX ITSELF is
 *      what shoppers receive.
 *
 * All logic lives in app/services/badge-doctor.server.ts (dev-testable);
 * this route stays thin: loader = steps 1/2/4/5, action = steps 3/6.
 */
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs, SerializeFrom } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  IndexTable,
  InlineStack,
  Layout,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import {
  apiDryRunWithTrace,
  badgePreviewStep,
  deployedExtensionCheck,
  liveGatingStep,
  rateLimitStep,
  reviewDataStep,
} from "~/services/badge-doctor.server";
import type {
  DeployedCheckData,
  DryRunResult,
  StepResult,
} from "~/services/badge-doctor.server";
import { MAX_BADGE_HANDLES } from "~/services/badges.server";
import { StarRating } from "~/components/admin/StarRating";
import { useResultToast } from "~/components/admin/useResultToast";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [preview, reviewData, liveGating] = await Promise.all([
    badgePreviewStep(shop),
    reviewDataStep(shop),
    liveGatingStep(shop),
  ]);
  const rateLimits = rateLimitStep();
  // Step-3 prefill: every handle observed on review rows (canonical +
  // translated aliases), capped at what one badges request may carry.
  const knownHandles = [
    ...new Set(reviewData.rows.flatMap((row) => row.handles)),
  ].slice(0, MAX_BADGE_HANDLES);
  // maxHandles rides in the loader data because the component must not import
  // badges.server itself — a server-only import reachable from the client
  // bundle fails the production build (Remix vite splitting).
  return json({
    shop,
    preview,
    reviewData,
    liveGating,
    rateLimits,
    knownHandles,
    maxHandles: MAX_BADGE_HANDLES,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "dry-run") {
      const dryRun = await apiDryRunWithTrace(
        shop,
        admin,
        String(form.get("handles") ?? ""),
        String(form.get("root") ?? ""),
      );
      return json({ ok: true, dryRun });
    }
    // SPEC-1.32 §2 step 6 — merchant-invoked only; the service maps every
    // failure to an actionable FAIL result and never throws.
    if (intent === "deployed-check") {
      const deployed = await deployedExtensionCheck(shop);
      return json({ ok: true, deployed });
    }
    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    // A re-auth or redirect Response must pass through, not become a 500.
    if (error instanceof Response) throw error;
    console.error("Badge doctor action failed", error);
    return json({ ok: false, message: "Something went wrong. Please try again." }, { status: 500 });
  }
};

type LoaderData = SerializeFrom<typeof loader>;

/** PASS / WARN / FAIL → the Polaris Badge tones the spec names (§2). */
function VerdictBadge({ status }: { status: StepResult["status"] }) {
  if (status === "pass") return <Badge tone="success">PASS</Badge>;
  if (status === "warn") return <Badge tone="warning">WARN</Badge>;
  return <Badge tone="critical">FAIL</Badge>;
}

/** Step heading + verdict + the plain-language "what this means / what to do". */
function StepHeader({ step, result }: { step: number; result: StepResult }) {
  return (
    <BlockStack gap="150">
      <InlineStack gap="200" blockAlign="center">
        <Text as="h2" variant="headingMd">
          {`Step ${step} — ${result.title}`}
        </Text>
        <VerdictBadge status={result.status} />
      </InlineStack>
      <Text as="p" variant="bodySm">
        {result.detail}
      </Text>
      {result.remedy ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {result.remedy}
        </Text>
      ) : null}
    </BlockStack>
  );
}

/**
 * Server-rendered replica of the card badge. `withScore` = the v1.32 anatomy
 * (numeric score → stars → (count) — the §1 PDP-order arrangement, score
 * FIRST, exactly as buildInlineBadge appends it); without it, the pre-1.32
 * anatomy the merchant reported (no number). Stars are half-rounded exactly
 * like the extension's buildInlineBadge; the score is the one-decimal value
 * the extension formats with NF1.
 */
function CardBadgeReplica({
  average,
  count,
  withScore,
}: {
  average: number;
  count: number;
  withScore: boolean;
}) {
  const halfRounded = Math.round(average * 2) / 2;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      {withScore ? (
        <span style={{ fontSize: 13, fontWeight: 600 }}>{average.toFixed(1)}</span>
      ) : null}
      <StarRating rating={halfRounded} size={16} />
      <span style={{ fontSize: 13, color: "#616A75" }}>({count.toLocaleString("en")})</span>
    </span>
  );
}

export default function BadgeDoctorRoute() {
  const { shop, preview, reviewData, liveGating, rateLimits, knownHandles, maxHandles } =
    useLoaderData<typeof loader>();

  const dryRunFetcher = useFetcher<typeof action>();
  const deployedFetcher = useFetcher<typeof action>();
  useResultToast(dryRunFetcher);
  useResultToast(deployedFetcher);

  const [handlesText, setHandlesText] = useState(knownHandles.join(", "));
  const [rootText, setRootText] = useState("");

  const dryRun =
    dryRunFetcher.data && "dryRun" in dryRunFetcher.data
      ? (dryRunFetcher.data.dryRun as SerializeFrom<DryRunResult>)
      : null;
  const deployed =
    deployedFetcher.data && "deployed" in deployedFetcher.data
      ? (deployedFetcher.data.deployed as SerializeFrom<DeployedCheckData>)
      : null;

  const runDryRun = () =>
    dryRunFetcher.submit(
      { intent: "dry-run", handles: handlesText, root: rootText },
      { method: "post" },
    );
  const runDeployedCheck = () =>
    deployedFetcher.submit({ intent: "deployed-check" }, { method: "post" });

  return (
    <Page
      title="Badge doctor"
      subtitle="Step-by-step diagnosis of the card star badges — from your review data to the exact code shoppers receive."
    >
      <TitleBar title="Badge doctor" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {/* Step 1 — Expected badge preview (before/after replicas). */}
            <Card>
              <BlockStack gap="300">
                <StepHeader step={1} result={preview.result} />
                <Divider />
                <BlockStack gap="200">
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" tone="subdued">
                      What every card badge shows from v1.32 (numeric rating, stars, count)
                      {preview.preview.sample
                        ? " — sample numbers"
                        : preview.preview.productTitle
                          ? ` — real data from “${preview.preview.productTitle}”`
                          : ""}
                    </Text>
                    <CardBadgeReplica
                      average={preview.preview.average}
                      count={preview.preview.count}
                      withScore
                    />
                  </BlockStack>
                  <BlockStack gap="050">
                    <Text as="span" variant="bodySm" tone="subdued">
                      What you saw before (no number)
                    </Text>
                    <CardBadgeReplica
                      average={preview.preview.average}
                      count={preview.preview.count}
                      withScore={false}
                    />
                  </BlockStack>
                </BlockStack>
              </BlockStack>
            </Card>

            {/* Step 2 — Review data. */}
            <Card padding="0">
              <Box padding="400" paddingBlockEnd="200">
                <StepHeader step={2} result={reviewData.result} />
              </Box>
              <IndexTable
                resourceName={{ singular: "product", plural: "products" }}
                itemCount={reviewData.rows.length}
                selectable={false}
                headings={[
                  { title: "Product" },
                  { title: "Published" },
                  { title: "Total rows" },
                  { title: "Average" },
                  { title: "Handles on rows" },
                  { title: "Status" },
                ]}
                emptyState={
                  <Box padding="400">
                    <Text as="p" tone="subdued">
                      No review rows yet — nothing for badges to count.
                    </Text>
                  </Box>
                }
              >
                {reviewData.rows.map((row, index) => (
                  <IndexTable.Row id={row.productId} key={row.productId} position={index}>
                    <IndexTable.Cell>
                      <BlockStack gap="050">
                        <Text as="span" fontWeight="semibold">
                          {row.productTitle ?? `Product ${row.productId}`}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          ID {row.productId}
                        </Text>
                      </BlockStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{row.publishedCount}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{row.totalCount}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{row.publishedCount > 0 ? row.average.toFixed(1) : "—"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span" variant="bodySm">
                        {row.handles.length > 0 ? row.handles.join(", ") : "—"}
                      </Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {row.zeroPublished ? (
                        <Badge tone="critical">No published reviews</Badge>
                      ) : (
                        <Badge tone="success">OK</Badge>
                      )}
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>

            {/* Step 3 — API dry-run with trace. */}
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Step 3 — API dry-run with trace
                    </Text>
                    {dryRun ? <VerdictBadge status={dryRun.result.status} /> : null}
                  </InlineStack>
                  <Text as="p" variant="bodySm">
                    Runs the REAL badge lookup — the same code, caches and resolution
                    chain a shopper request uses, including Shopify lookups for unknown
                    handles and, with a locale root, live storefront lookups — and shows
                    the path every handle took plus the exact JSON shoppers would receive.
                  </Text>
                </BlockStack>
                <TextField
                  label="Product handles (comma or space separated)"
                  value={handlesText}
                  onChange={setHandlesText}
                  multiline={2}
                  autoComplete="off"
                  helpText={`Prefilled with the handles found on your review rows. Up to ${maxHandles} per run.`}
                />
                <TextField
                  label="Locale root (optional)"
                  value={rootText}
                  onChange={setRootText}
                  autoComplete="off"
                  placeholder="fr"
                  helpText="For translated storefront handles: the locale prefix of the page (fr, /pt-br/, …). Leave empty for the default locale."
                />
                <InlineStack>
                  <Button
                    variant="primary"
                    onClick={runDryRun}
                    loading={dryRunFetcher.state !== "idle"}
                  >
                    Run dry-run
                  </Button>
                </InlineStack>
                {dryRun ? (
                  <BlockStack gap="300">
                    <Divider />
                    <Text as="p" variant="bodySm">
                      {dryRun.result.detail}
                    </Text>
                    {dryRun.result.remedy ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {dryRun.result.remedy}
                      </Text>
                    ) : null}
                    <BlockStack gap="150">
                      {dryRun.handles.map((entry) => (
                        <InlineStack key={entry.handle} gap="200" blockAlign="center" wrap>
                          <Text as="span" fontWeight="semibold">
                            {entry.handle}
                          </Text>
                          {entry.invalid ? (
                            <Badge tone="critical">not a valid handle</Badge>
                          ) : (
                            <Text as="span" variant="bodySm" tone="subdued">
                              {entry.path.length > 0 ? entry.path.join(" → ") : "(no trace)"}
                            </Text>
                          )}
                          {entry.badge ? (
                            <Badge tone="success">
                              {`${entry.badge.average.toFixed(1)} ★ · ${entry.badge.count} review(s)`}
                            </Badge>
                          ) : (
                            <Badge tone="warning">omitted</Badge>
                          )}
                        </InlineStack>
                      ))}
                    </BlockStack>
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Exact response the storefront would receive
                        {dryRun.root ? ` (locale root ${dryRun.root})` : ""}
                      </Text>
                      <Box
                        background="bg-surface-secondary"
                        padding="300"
                        borderRadius="200"
                        overflowX="scroll"
                      >
                        <pre style={{ margin: 0, fontSize: 12, whiteSpace: "pre-wrap" }}>
                          {dryRun.responseJson}
                        </pre>
                      </Box>
                    </BlockStack>
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>

            {/* Step 4 — Live gating. */}
            <Card>
              <BlockStack gap="200">
                <StepHeader step={4} result={liveGating.result} />
                <Text as="p" variant="bodySm" tone="subdued">
                  {`isLive: ${liveGating.gating.isLive ? "yes" : "no"} · scope: ${
                    liveGating.gating.liveScope === "markets"
                      ? `markets (${liveGating.gating.liveMarkets.join(", ") || "none"})`
                      : "all markets"
                  }`}
                </Text>
              </BlockStack>
            </Card>

            {/* Step 5 — Rate limits (rendered from RATE_LIMITS, never hardcoded). */}
            <Card>
              <BlockStack gap="200">
                <StepHeader step={5} result={rateLimits.result} />
                <Text as="p" variant="bodySm" tone="subdued">
                  {`badges bucket: ${rateLimits.limits.max} requests per ${Math.round(
                    rateLimits.limits.windowMs / 3_600_000,
                  )} hour(s) per shop:ip bucket · CELLEXIA_CLIENT_IP_HEADER: ${
                    rateLimits.limits.ipHeaderSet ? "set" : "not set"
                  }`}
                </Text>
              </BlockStack>
            </Card>

            {/* Step 6 — Deployed-extension check (merchant-invoked). */}
            <Card>
              <BlockStack gap="300">
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h2" variant="headingMd">
                      Step 6 — Deployed-extension check
                    </Text>
                    {deployed ? <VerdictBadge status={deployed.result.status} /> : null}
                  </InlineStack>
                  <Text as="p" variant="bodySm">
                    The guarantee step: fetches your own storefront ({`https://${shop}/`})
                    and the extension file it references from Shopify's CDN, and verifies
                    the code shoppers receive renders the numeric rating. Runs only when
                    you click the button.
                  </Text>
                </BlockStack>
                <InlineStack>
                  <Button
                    variant="primary"
                    onClick={runDeployedCheck}
                    loading={deployedFetcher.state !== "idle"}
                  >
                    Check what shoppers receive
                  </Button>
                </InlineStack>
                {deployed ? (
                  <BlockStack gap="200">
                    <Divider />
                    <Text as="p" variant="bodySm">
                      {deployed.result.detail}
                    </Text>
                    {deployed.result.remedy ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {deployed.result.remedy}
                      </Text>
                    ) : null}
                    {deployed.config ? (
                      <Text as="p" variant="bodySm" tone="subdued">
                        {`Served app-embed settings — enable_badges: ${String(
                          deployed.config.enableBadges,
                        )} · badge_style: ${deployed.config.badgeStyle ?? "?"} · card_badge_position: ${
                          deployed.config.cardBadgePosition ?? "?"
                        }${deployed.build ? ` · build: ${deployed.build}` : ""}`}
                      </Text>
                    ) : null}
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
