import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  SerializeFrom,
} from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  Divider,
  InlineGrid,
  InlineStack,
  Link as PolarisLink,
  Page,
  Text,
  Tooltip,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { getSettings, updateSettings } from "~/services/settings.server";
import { syncShopSettingsMetafields } from "~/services/metafields.server";
import { getPreviewUrl } from "~/services/preview.server";
import { generateSummary } from "~/services/ai.server";
import {
  syncProductData,
  updateReviewStatuses,
} from "~/components/admin/moderation.server";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import { StarRating } from "~/components/admin/StarRating";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, formatDateTime, pluralize } from "~/components/admin/labels";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const [
    settings,
    previewUrl,
    totalReviews,
    publishedAgg,
    pendingCount,
    publishedThisMonth,
    syntheticPublishedCount,
    attentionRows,
    productGroups,
  ] = await Promise.all([
    getSettings(shop),
    getPreviewUrl(admin, shop),
    prisma.review.count({ where: { shop } }),
    prisma.review.aggregate({
      where: { shop, status: "PUBLISHED" },
      _avg: { rating: true },
      _count: { _all: true },
    }),
    prisma.review.count({ where: { shop, status: "PENDING" } }),
    prisma.review.count({
      where: { shop, status: "PUBLISHED", createdAt: { gte: monthStart } },
    }),
    prisma.review.count({
      where: { shop, isSynthetic: true, status: "PUBLISHED" },
    }),
    prisma.review.findMany({
      where: {
        shop,
        OR: [{ status: "PENDING" }, { status: "PUBLISHED", reportCount: { gt: 0 } }],
      },
      orderBy: { createdAt: "desc" },
      take: 8,
    }),
    prisma.review.groupBy({
      by: ["productId"],
      where: { shop, status: "PUBLISHED" },
      _count: { _all: true },
      _avg: { rating: true },
      _max: { createdAt: true },
    }),
  ]);

  const productIds = productGroups.map((g) => g.productId);
  const [titleRows, summaryRows] = await Promise.all([
    productIds.length
      ? prisma.review.findMany({
          where: { shop, productId: { in: productIds } },
          select: { productId: true, productTitle: true },
          distinct: ["productId"],
        })
      : Promise.resolve([]),
    productIds.length
      ? prisma.summary.findMany({
          where: { shop, productId: { in: productIds } },
          orderBy: { updatedAt: "desc" },
        })
      : Promise.resolve([]),
  ]);

  const titleByProduct = new Map(titleRows.map((r) => [r.productId, r.productTitle]));
  const summaryByProduct = new Map<string, Date>();
  for (const s of summaryRows) {
    if (!summaryByProduct.has(s.productId)) {
      summaryByProduct.set(s.productId, s.updatedAt);
    }
  }

  const products = productGroups
    .map((g) => ({
      productId: g.productId,
      title: titleByProduct.get(g.productId) ?? `Product ${g.productId}`,
      average: g._avg.rating ?? 0,
      count: g._count._all,
      lastReviewAt: g._max.createdAt,
      summaryUpdatedAt: summaryByProduct.get(g.productId) ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  return json({
    shop,
    isLive: settings.isLive,
    previewUrl,
    stats: {
      average: publishedAgg._avg.rating,
      totalReviews,
      pendingCount,
      publishedThisMonth,
    },
    syntheticPublishedCount,
    setup: {
      hasAiKey: Boolean(settings.anthropicApiKey),
      hasModerated: publishedAgg._count._all > 0,
    },
    needsAttention: attentionRows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body.length > 180 ? `${r.body.slice(0, 180)}…` : r.body,
      authorName: r.authorName,
      productTitle: r.productTitle,
      status: r.status,
      reportCount: r.reportCount,
      createdAt: r.createdAt,
    })),
    products,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "approve" || intent === "reject") {
      const id = String(form.get("id") ?? "");
      if (!id) {
        return json({ ok: false, message: "Missing review id" }, { status: 400 });
      }
      const status = intent === "approve" ? "PUBLISHED" : "REJECTED";
      const changed = await updateReviewStatuses(shop, [id], status, admin);
      if (!changed) {
        return json({ ok: false, message: "Review not found" }, { status: 404 });
      }
      return json({
        ok: true,
        message: intent === "approve" ? "Review approved and published" : "Review rejected",
      });
    }

    if (intent === "go-live" || intent === "go-offline") {
      const isLive = intent === "go-live";
      const saved = await updateSettings(shop, { isLive });
      // Mirror the change onto the SHOP metafield (cellexia.live) so the theme
      // extension shows/hides the widget without a DB round-trip.
      await syncShopSettingsMetafields(admin, saved);
      return json({
        ok: true,
        message: isLive
          ? "You're live!"
          : "The review widget is now hidden from store visitors",
      });
    }

    if (intent === "regenerate-summary") {
      const productId = String(form.get("productId") ?? "");
      if (!productId) {
        return json({ ok: false, message: "Missing product id" }, { status: 400 });
      }
      const summary = await generateSummary(shop, productId, "en");
      if (!summary) {
        return json({
          ok: false,
          message: "Summary could not be generated. Check the AI settings and API key.",
        });
      }
      await syncProductData(shop, productId, admin);
      return json({ ok: true, message: "AI summary regenerated" });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Dashboard action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

type LoaderData = SerializeFrom<typeof loader>;

function SetupStep({
  index,
  text,
  done,
  action,
}: {
  index: number;
  text: string;
  done: boolean;
  action: ReactNode;
}) {
  return (
    <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
      <InlineStack gap="300" blockAlign="center">
        <span
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: done ? "#B4FED2" : "#E3E3E3",
            fontSize: 12,
            fontWeight: 700,
            flex: "0 0 auto",
          }}
        >
          {index}
        </span>
        <Text as="span">{text}</Text>
        {done ? <Badge tone="success">Done</Badge> : null}
      </InlineStack>
      {action}
    </InlineStack>
  );
}

/**
 * Opens the tokenized storefront preview in a new tab. When the store has no
 * product page to preview on (`previewUrl` is null) the button is disabled
 * with an explanatory tooltip.
 */
function PreviewLinkButton({
  previewUrl,
  children,
}: {
  previewUrl: string | null;
  children: string;
}) {
  if (!previewUrl) {
    return (
      <Tooltip content="The preview opens on a product page — add at least one product to your store first.">
        <Button disabled>{children}</Button>
      </Tooltip>
    );
  }
  return (
    <Button onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")}>
      {children}
    </Button>
  );
}

function StatCard({ label, value, extra }: { label: string; value: string; extra?: ReactNode }) {
  return (
    <Card>
      <BlockStack gap="150">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
        <InlineStack gap="200" blockAlign="center">
          <Text as="p" variant="headingLg">
            {value}
          </Text>
          {extra}
        </InlineStack>
      </BlockStack>
    </Card>
  );
}

function AttentionRow({ review }: { review: LoaderData["needsAttention"][number] }) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher);
  const busy = fetcher.state !== "idle";
  const pendingIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : "";

  const submit = useCallback(
    (intent: "approve" | "reject") => {
      fetcher.submit({ intent, id: review.id }, { method: "post" });
    },
    [fetcher, review.id],
  );

  return (
    <Box paddingBlock="300">
      <InlineStack align="space-between" blockAlign="start" gap="400" wrap>
        <Box maxWidth="640px">
          <BlockStack gap="100">
            <InlineStack gap="200" blockAlign="center" wrap>
              <StarRating rating={review.rating} size={14} />
              <PolarisLink url={`/app/reviews/${review.id}`} removeUnderline>
                <Text as="span" fontWeight="semibold">
                  {review.title || "Untitled review"}
                </Text>
              </PolarisLink>
              <StatusBadge status={review.status} />
              {review.reportCount > 0 ? (
                <Badge tone="critical">{pluralize(review.reportCount, "report")}</Badge>
              ) : null}
            </InlineStack>
            <Text as="span" variant="bodySm" tone="subdued">
              {review.authorName}
              {review.productTitle ? ` · ${review.productTitle}` : ""} ·{" "}
              {formatDate(review.createdAt)}
            </Text>
            <Text as="p" variant="bodySm">
              {review.body}
            </Text>
          </BlockStack>
        </Box>
        <InlineStack gap="200">
          <Button
            size="slim"
            onClick={() => submit("approve")}
            loading={pendingIntent === "approve"}
            disabled={busy && pendingIntent !== "approve"}
          >
            Approve
          </Button>
          <Button
            size="slim"
            tone="critical"
            onClick={() => submit("reject")}
            loading={pendingIntent === "reject"}
            disabled={busy && pendingIntent !== "reject"}
          >
            Reject
          </Button>
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

function RegenerateSummaryCell({
  productId,
  summaryUpdatedAt,
}: {
  productId: string;
  summaryUpdatedAt: string | null;
}) {
  const fetcher = useFetcher<typeof action>();
  useResultToast(fetcher);

  return (
    <InlineStack gap="200" blockAlign="center" wrap>
      <Text as="span" variant="bodySm" tone="subdued">
        {summaryUpdatedAt ? `Generated ${formatDateTime(summaryUpdatedAt)}` : "Not generated yet"}
      </Text>
      <Button
        size="slim"
        loading={fetcher.state !== "idle"}
        onClick={() =>
          fetcher.submit({ intent: "regenerate-summary", productId }, { method: "post" })
        }
      >
        Regenerate AI summary
      </Button>
    </InlineStack>
  );
}

export default function Dashboard() {
  const {
    shop,
    isLive,
    previewUrl,
    stats,
    setup,
    needsAttention,
    products,
    syntheticPublishedCount,
  } = useLoaderData<typeof loader>();

  const liveFetcher = useFetcher<typeof action>();
  const [liveConfirm, setLiveConfirm] = useState<"go-live" | "go-offline" | null>(null);
  const closeLiveConfirm = useCallback(() => setLiveConfirm(null), []);
  useResultToast(liveFetcher, closeLiveConfirm);
  const liveBusy = liveFetcher.state !== "idle";

  const themeEditorUrl = `https://${shop}/admin/themes/current/editor?template=product&context=apps`;
  const setupComplete = setup.hasAiKey && setup.hasModerated && isLive;

  const productRows = products.map((p) => [
    <Text as="span" fontWeight="medium" key={`t-${p.productId}`}>
      {p.title}
    </Text>,
    <InlineStack gap="150" blockAlign="center" key={`a-${p.productId}`}>
      <StarRating rating={p.average} size={14} />
      <Text as="span">{p.average.toFixed(1)}</Text>
    </InlineStack>,
    p.count,
    formatDate(p.lastReviewAt),
    <RegenerateSummaryCell
      key={`r-${p.productId}`}
      productId={p.productId}
      summaryUpdatedAt={p.summaryUpdatedAt}
    />,
  ]);

  return (
    <Page title="Dashboard" subtitle="Cellexia Reviews">
      <TitleBar title="Dashboard" />
      <BlockStack gap="500">
        {isLive ? (
          <Banner tone="success" title="Live — visitors can see the review widget.">
            <InlineStack gap="300" blockAlign="center" wrap>
              <PreviewLinkButton previewUrl={previewUrl}>Preview link</PreviewLinkButton>
              <Button variant="plain" onClick={() => setLiveConfirm("go-offline")}>
                Switch off
              </Button>
            </InlineStack>
          </Banner>
        ) : (
          <Banner
            tone="warning"
            title="Not live yet — store visitors can't see the review widget."
          >
            <BlockStack gap="200">
              <Text as="p">
                Preview the widget on your live theme — only you can see the preview — then go
                live when you're ready.
              </Text>
              <InlineStack gap="200" blockAlign="center" wrap>
                <PreviewLinkButton previewUrl={previewUrl}>
                  Preview on your store
                </PreviewLinkButton>
                <Button variant="primary" onClick={() => setLiveConfirm("go-live")}>
                  Go live
                </Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        )}

        {syntheticPublishedCount > 0 ? (
          isLive ? (
            <Banner
              tone="critical"
              title={
                syntheticPublishedCount === 1
                  ? "1 synthetic test review is visible to real shoppers — delete it before customers see it."
                  : `${syntheticPublishedCount} synthetic test reviews are visible to real shoppers — delete them before customers see them.`
              }
              action={{ content: "Open QA data", url: "/app/qa-generator" }}
            >
              <Text as="p">
                Synthetic reviews look completely real in the widget and are labeled only in
                this admin. Delete every batch on the QA data page — product ratings
                recalculate automatically.
              </Text>
            </Banner>
          ) : (
            <Banner
              tone="info"
              title={`${pluralize(syntheticPublishedCount, "synthetic test review")} ${
                syntheticPublishedCount === 1 ? "is" : "are"
              } published.`}
              action={{ content: "Open QA data", url: "/app/qa-generator" }}
            >
              <Text as="p">
                Store visitors can't see them while the widget is not live. Once live they
                look completely real to shoppers — delete every batch on the QA data page
                before you go live.
              </Text>
            </Banner>
          )
        ) : null}

        {!setupComplete ? (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Get started with Cellexia Reviews
              </Text>
              <SetupStep
                index={1}
                text="Add the Cellexia Reviews block to your product template in the theme editor."
                done={false}
                action={
                  <Button url={themeEditorUrl} target="_blank">
                    Open theme editor
                  </Button>
                }
              />
              <Divider />
              <SetupStep
                index={2}
                text="Add your Anthropic API key to enable AI summaries and review translation."
                done={setup.hasAiKey}
                action={<Button url="/app/settings">Open settings</Button>}
              />
              <Divider />
              <SetupStep
                index={3}
                text="Moderate your first reviews so they appear on your storefront."
                done={setup.hasModerated}
                action={<Button url="/app/reviews">Go to reviews</Button>}
              />
              <Divider />
              <SetupStep
                index={4}
                text="Preview, then go live — check the widget on your live theme, then make it visible to visitors."
                done={isLive}
                action={
                  <InlineStack gap="200">
                    <PreviewLinkButton previewUrl={previewUrl}>Preview</PreviewLinkButton>
                    {!isLive ? (
                      <Button variant="primary" onClick={() => setLiveConfirm("go-live")}>
                        Go live
                      </Button>
                    ) : null}
                  </InlineStack>
                }
              />
            </BlockStack>
          </Card>
        ) : null}

        <InlineGrid columns={{ xs: 1, sm: 2, lg: 4 }} gap="400">
          <StatCard
            label="Average rating"
            value={stats.average != null ? stats.average.toFixed(1) : "—"}
            extra={
              stats.average != null ? <StarRating rating={stats.average} size={16} /> : undefined
            }
          />
          <StatCard label="Total reviews" value={String(stats.totalReviews)} />
          <StatCard label="Pending moderation" value={String(stats.pendingCount)} />
          <StatCard label="Published this month" value={String(stats.publishedThisMonth)} />
        </InlineGrid>

        <Card>
          <BlockStack gap="200">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                Needs attention
              </Text>
              <Button url="/app/reviews?tab=pending" variant="plain">
                View all pending
              </Button>
            </InlineStack>
            {needsAttention.length === 0 ? (
              <Text as="p" tone="subdued">
                You are all caught up — no reviews are waiting for moderation.
              </Text>
            ) : (
              <BlockStack gap="0">
                {needsAttention.map((review, i) => (
                  <BlockStack gap="0" key={review.id}>
                    {i > 0 ? <Divider /> : null}
                    <AttentionRow review={review} />
                  </BlockStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingMd">
              Products
            </Text>
            {products.length === 0 ? (
              <Text as="p" tone="subdued">
                No published reviews yet. Once reviews are approved they are grouped by product
                here.
              </Text>
            ) : (
              <DataTable
                columnContentTypes={["text", "text", "numeric", "text", "text"]}
                headings={["Product", "Average", "Reviews", "Last review", "AI summary"]}
                rows={productRows}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      <ConfirmationModal
        open={liveConfirm === "go-live"}
        title="Go live?"
        message="Make Cellexia Reviews visible to all store visitors?"
        confirmLabel="Go live"
        destructive={false}
        loading={liveBusy}
        onConfirm={() => liveFetcher.submit({ intent: "go-live" }, { method: "post" })}
        onCancel={closeLiveConfirm}
      />
      <ConfirmationModal
        open={liveConfirm === "go-offline"}
        title="Switch off the review widget?"
        message="Hide the review widget from all store visitors? Your data is kept."
        confirmLabel="Switch off"
        loading={liveBusy}
        onConfirm={() => liveFetcher.submit({ intent: "go-offline" }, { method: "post" })}
        onCancel={closeLiveConfirm}
      />
    </Page>
  );
}
