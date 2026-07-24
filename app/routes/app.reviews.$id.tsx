import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { getSettings } from "~/services/settings.server";
import { translateReviews } from "~/services/translate.server";
import { SHOP_LOCALES, REVIEW_STATUSES } from "~/types/cellexia";
import type { ReviewSource } from "~/types/cellexia";
import {
  deleteReviews,
  updateReviewStatuses,
} from "~/components/admin/moderation.server";
import { StarRating } from "~/components/admin/StarRating";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { MediaThumbs } from "~/components/admin/MediaThumbs";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import { useResultToast } from "~/components/admin/useResultToast";
import {
  AGE_RANGE_LABELS,
  LOCALE_LABELS,
  REPORT_REASON_LABELS,
  RESULTS_SEEN_LABELS,
  SKIN_CONCERN_LABELS,
  TIME_USING_LABELS,
  formatDate,
  formatDateTime,
  labelFor,
  labelsFor,
  parseKeyArray,
  pluralize,
} from "~/components/admin/labels";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id ?? "";

  const review = await prisma.review.findFirst({
    where: { id, shop },
    include: { media: { orderBy: { position: "asc" } }, votes: true },
  });
  if (!review) {
    throw new Response("Review not found", { status: 404 });
  }

  const settings = await getSettings(shop);

  const reportReasons: Record<string, number> = {};
  for (const vote of review.votes) {
    if (vote.type === "REPORT") {
      const reason = vote.reason ?? "other";
      reportReasons[reason] = (reportReasons[reason] ?? 0) + 1;
    }
  }

  return json({
    review: {
      id: review.id,
      productId: review.productId,
      productTitle: review.productTitle,
      productHandle: review.productHandle,
      rating: review.rating,
      title: review.title,
      body: review.body,
      language: review.language,
      authorName: review.authorName,
      authorEmail: review.authorEmail,
      customerId: review.customerId,
      country: review.country,
      variantTitle: review.variantTitle,
      verified: review.verified,
      status: review.status,
      ageRange: review.ageRange,
      skinConcerns: parseKeyArray(review.skinConcerns),
      timeUsing: review.timeUsing,
      resultsSeen: parseKeyArray(review.resultsSeen),
      helpfulCount: review.helpfulCount,
      reportCount: review.reportCount,
      reply: review.reply,
      replyAt: review.replyAt,
      isSynthetic: review.isSynthetic,
      source: review.source,
      syntheticBatchId: review.syntheticBatchId,
      syntheticGeneratedAt: review.syntheticGeneratedAt,
      createdAt: review.createdAt,
      updatedAt: review.updatedAt,
      media: review.media.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbUrl: m.thumbUrl,
      })),
    },
    reportReasons,
    brand: settings.brandDisplayName,
    translationProvider: settings.translationProvider,
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const id = params.id ?? "";
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  const review = await prisma.review.findFirst({ where: { id, shop }, select: { id: true } });
  if (!review) {
    return json({ ok: false, message: "Review not found" }, { status: 404 });
  }

  try {
    if (intent === "set-status") {
      const status = String(form.get("status") ?? "");
      if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
        return json({ ok: false, message: "Invalid status" }, { status: 400 });
      }
      await updateReviewStatuses(shop, [id], status, admin);
      const messages: Record<string, string> = {
        PUBLISHED: "Review approved and published",
        REJECTED: "Review rejected",
        SPAM: "Review marked as spam",
        PENDING: "Review moved back to moderation",
      };
      return json({ ok: true, message: messages[status] });
    }

    if (intent === "delete") {
      await deleteReviews(shop, [id], admin);
      return redirect("/app/reviews");
    }

    if (intent === "reply") {
      const reply = String(form.get("reply") ?? "").trim();
      await prisma.review.update({
        where: { id },
        data: reply ? { reply, replyAt: new Date() } : { reply: null, replyAt: null },
      });
      return json({ ok: true, message: reply ? "Reply saved" : "Reply removed" });
    }

    if (intent === "translate") {
      const target = String(form.get("target") ?? "");
      if (!(SHOP_LOCALES as readonly string[]).includes(target)) {
        return json({ ok: false, message: "Unsupported language" }, { status: 400 });
      }
      const translations = await translateReviews(shop, [id], target, {
        includeUnpublished: true,
      });
      const translation = translations[id];
      if (!translation) {
        return json({
          ok: false,
          message: "Translation unavailable. Check the translation settings.",
        });
      }
      return json({ ok: true, translation, target });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Review detail action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

/** Admin labels for Review.source values (a NULL column counts as "Storefront"). */
const SOURCE_LABELS: Record<ReviewSource, string> = {
  storefront: "Storefront",
  "csv-import": "CSV import",
  "bulk-add": "Bulk add",
  synthetic: "Synthetic (QA generator)",
};

function sourceLabel(source: string | null): string {
  if (!source) return "Storefront";
  return SOURCE_LABELS[source as ReviewSource] ?? source;
}

function AttrRow({ label, value }: { label: string; value: string | null }) {
  return (
    <InlineStack gap="200" blockAlign="start" wrap={false}>
      <Box minWidth="160px">
        <Text as="span" variant="bodySm" tone="subdued">
          {label}
        </Text>
      </Box>
      <Text as="span" variant="bodySm">
        {value ?? "Not provided"}
      </Text>
    </InlineStack>
  );
}

export default function ReviewDetail() {
  const { review, reportReasons, brand, translationProvider } =
    useLoaderData<typeof loader>();

  const shopify = useAppBridge();
  const statusFetcher = useFetcher<typeof action>();
  const replyFetcher = useFetcher<typeof action>();
  const translateFetcher = useFetcher<typeof action>();

  const copyBatchId = useCallback(async () => {
    const batchId = review.syntheticBatchId;
    if (!batchId) return;
    try {
      await navigator.clipboard.writeText(batchId);
      shopify.toast.show("Batch ID copied");
    } catch (error) {
      // Clipboard access can be denied inside the embedded iframe — the full
      // id stays visible in the banner so it can be selected manually.
      console.error("Copying the batch ID failed", error);
      shopify.toast.show("Couldn't copy — select the batch ID text instead", {
        isError: true,
      });
    }
  }, [review.syntheticBatchId, shopify]);

  useResultToast(statusFetcher);
  useResultToast(replyFetcher);
  useResultToast(translateFetcher);

  const [replyDraft, setReplyDraft] = useState(review.reply ?? "");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [target, setTarget] = useState<string>("en");

  const statusBusy = statusFetcher.state !== "idle";
  const pendingStatus = statusBusy ? String(statusFetcher.formData?.get("status") ?? "") : "";

  const setStatus = (status: string) =>
    statusFetcher.submit({ intent: "set-status", status }, { method: "post" });

  const translation =
    translateFetcher.data && "translation" in translateFetcher.data
      ? translateFetcher.data.translation
      : null;
  const translationTarget =
    translateFetcher.data && "target" in translateFetcher.data
      ? translateFetcher.data.target
      : null;

  const verificationText = review.verified
    ? review.customerId
      ? "Verified — the reviewer was logged in as a customer whose orders include this product."
      : "Verified — an order containing this product was found for the reviewer's email address."
    : "Not verified — no matching order was found for this reviewer.";

  const reportEntries = Object.entries(reportReasons);

  return (
    <Page
      title={review.title || `Review by ${review.authorName}`}
      subtitle={review.productTitle ?? undefined}
      backAction={{ content: "Reviews", url: "/app/reviews" }}
      titleMetadata={<StatusBadge status={review.status} />}
    >
      <TitleBar title="Review" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {review.isSynthetic ? (
              <Banner tone="info" title="Synthetic test review">
                <BlockStack gap="200">
                  <Text as="p">
                    This review was generated by the QA data tool. It looks completely real
                    on the storefront and is labeled only here in the admin — delete its
                    batch before going live to real customers.
                  </Text>
                  <InlineStack gap="300" blockAlign="center" wrap>
                    <Text as="span" variant="bodySm">
                      Source: {sourceLabel(review.source)} · Generated{" "}
                      {formatDateTime(review.syntheticGeneratedAt)}
                    </Text>
                  </InlineStack>
                  {review.syntheticBatchId ? (
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Text as="span" variant="bodySm">
                        Batch: <code>{review.syntheticBatchId}</code>
                      </Text>
                      <Button size="micro" onClick={copyBatchId}>
                        Copy ID
                      </Button>
                      <Button
                        size="micro"
                        url={`/app/reviews?batch=${encodeURIComponent(review.syntheticBatchId)}`}
                      >
                        View batch
                      </Button>
                    </InlineStack>
                  ) : null}
                </BlockStack>
              </Banner>
            ) : null}
            <Card>
              <BlockStack gap="300">
                <InlineStack gap="300" blockAlign="center" wrap>
                  <StarRating rating={review.rating} size={18} showValue />
                  <Text as="h2" variant="headingMd">
                    {review.title || "Untitled review"}
                  </Text>
                  {review.verified ? (
                    <Text as="span" variant="bodySm" fontWeight="bold" tone="caution">
                      Verified Purchase
                    </Text>
                  ) : null}
                </InlineStack>
                <Text as="span" variant="bodySm" tone="subdued">
                  By {review.authorName}
                  {review.country ? ` · ${review.country}` : ""} ·{" "}
                  {formatDate(review.createdAt)} ·{" "}
                  {LOCALE_LABELS[review.language] ?? review.language}
                  {review.variantTitle ? ` · Size: ${review.variantTitle}` : ""}
                </Text>
                <Text as="p">{review.body}</Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Structured answers
                </Text>
                {review.ageRange ||
                review.timeUsing ||
                review.skinConcerns.length ||
                review.resultsSeen.length ? (
                  <BlockStack gap="200">
                    <AttrRow
                      label="Age range"
                      value={labelFor(review.ageRange, AGE_RANGE_LABELS)}
                    />
                    <AttrRow
                      label="Skin concerns"
                      value={
                        review.skinConcerns.length
                          ? labelsFor(review.skinConcerns, SKIN_CONCERN_LABELS).join(", ")
                          : null
                      }
                    />
                    <AttrRow
                      label="Time using product"
                      value={labelFor(review.timeUsing, TIME_USING_LABELS)}
                    />
                    <AttrRow
                      label="Results seen"
                      value={
                        review.resultsSeen.length
                          ? labelsFor(review.resultsSeen, RESULTS_SEEN_LABELS).join(", ")
                          : null
                      }
                    />
                  </BlockStack>
                ) : (
                  <Text as="p" tone="subdued">
                    No structured answers provided.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Media ({review.media.length})
                </Text>
                <MediaThumbs media={review.media} size={96} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Reply as {brand}
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Your reply is published on the storefront under this review — this is how
                  the brand answers customers.
                </Text>
                <TextField
                  label="Reply"
                  labelHidden
                  multiline={4}
                  value={replyDraft}
                  onChange={setReplyDraft}
                  autoComplete="off"
                  placeholder="Thank you for sharing your experience…"
                />
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    loading={replyFetcher.state !== "idle"}
                    disabled={!replyDraft.trim() && !review.reply}
                    onClick={() =>
                      replyFetcher.submit(
                        { intent: "reply", reply: replyDraft },
                        { method: "post" },
                      )
                    }
                  >
                    Save reply
                  </Button>
                  {review.reply ? (
                    <Button
                      tone="critical"
                      variant="plain"
                      disabled={replyFetcher.state !== "idle"}
                      onClick={() => {
                        setReplyDraft("");
                        replyFetcher.submit({ intent: "reply", reply: "" }, { method: "post" });
                      }}
                    >
                      Remove reply
                    </Button>
                  ) : null}
                </InlineStack>
                {replyDraft.trim() ? (
                  <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                    <BlockStack gap="100">
                      <Text as="span" variant="bodySm" tone="subdued">
                        Storefront preview
                      </Text>
                      <Text as="span" fontWeight="bold">
                        Response from {brand}
                      </Text>
                      <Text as="span" variant="bodySm" tone="subdued">
                        {formatDate(review.replyAt ?? new Date().toISOString())}
                      </Text>
                      <Text as="p">{replyDraft}</Text>
                    </BlockStack>
                  </Box>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Translation preview
                </Text>
                {translationProvider === "off" ? (
                  <Text as="p" tone="subdued">
                    Review translation is turned off in Settings. Enable a translation
                    provider to preview this review in another language.
                  </Text>
                ) : (
                  <BlockStack gap="300">
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <Box minWidth="240px">
                        <Select
                          label="Preview in language"
                          options={SHOP_LOCALES.map((code) => ({
                            label: LOCALE_LABELS[code] ?? code,
                            value: code,
                          }))}
                          value={target}
                          onChange={setTarget}
                        />
                      </Box>
                      <Button
                        loading={translateFetcher.state !== "idle"}
                        onClick={() =>
                          translateFetcher.submit(
                            { intent: "translate", target },
                            { method: "post" },
                          )
                        }
                      >
                        Translate
                      </Button>
                    </InlineStack>
                    {translation ? (
                      <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                        <BlockStack gap="100">
                          <Text as="span" variant="bodySm" tone="subdued">
                            Machine translation (
                            {LOCALE_LABELS[translationTarget ?? ""] ?? translationTarget})
                          </Text>
                          {translation.title ? (
                            <Text as="span" fontWeight="semibold">
                              {translation.title}
                            </Text>
                          ) : null}
                          <Text as="p">{translation.body}</Text>
                          {translation.reply ? (
                            <BlockStack gap="050">
                              <Text as="span" variant="bodySm" fontWeight="semibold">
                                Reply
                              </Text>
                              <Text as="p" variant="bodySm">
                                {translation.reply}
                              </Text>
                            </BlockStack>
                          ) : null}
                        </BlockStack>
                      </Box>
                    ) : null}
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Status
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <StatusBadge status={review.status} />
                  {review.reportCount > 0 ? (
                    <Badge tone="critical">{pluralize(review.reportCount, "report")}</Badge>
                  ) : null}
                </InlineStack>
                <BlockStack gap="200">
                  {review.status !== "PUBLISHED" ? (
                    <Button
                      variant="primary"
                      fullWidth
                      loading={pendingStatus === "PUBLISHED"}
                      disabled={statusBusy && pendingStatus !== "PUBLISHED"}
                      onClick={() => setStatus("PUBLISHED")}
                    >
                      Approve & publish
                    </Button>
                  ) : null}
                  {review.status !== "REJECTED" ? (
                    <Button
                      fullWidth
                      loading={pendingStatus === "REJECTED"}
                      disabled={statusBusy && pendingStatus !== "REJECTED"}
                      onClick={() => setStatus("REJECTED")}
                    >
                      Reject
                    </Button>
                  ) : null}
                  {review.status !== "SPAM" ? (
                    <Button
                      fullWidth
                      loading={pendingStatus === "SPAM"}
                      disabled={statusBusy && pendingStatus !== "SPAM"}
                      onClick={() => setStatus("SPAM")}
                    >
                      Mark as spam
                    </Button>
                  ) : null}
                  {review.status !== "PENDING" ? (
                    <Button
                      fullWidth
                      variant="tertiary"
                      loading={pendingStatus === "PENDING"}
                      disabled={statusBusy && pendingStatus !== "PENDING"}
                      onClick={() => setStatus("PENDING")}
                    >
                      Move back to moderation
                    </Button>
                  ) : null}
                  <Divider />
                  <Button
                    fullWidth
                    tone="critical"
                    onClick={() => setDeleteOpen(true)}
                    disabled={statusBusy}
                  >
                    Delete review
                  </Button>
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Verification
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  {review.verified ? (
                    <Badge tone="success">Verified purchase</Badge>
                  ) : (
                    <Badge>Not verified</Badge>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {verificationText}
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Engagement
                </Text>
                <AttrRow label="Helpful votes" value={String(review.helpfulCount)} />
                <AttrRow label="Reports" value={String(review.reportCount)} />
                {reportEntries.length ? (
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      Report reasons
                    </Text>
                    {reportEntries.map(([reason, count]) => (
                      <Text as="span" variant="bodySm" tone="subdued" key={reason}>
                        {REPORT_REASON_LABELS[reason] ?? reason}: {count}
                      </Text>
                    ))}
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingMd">
                  Details
                </Text>
                <AttrRow label="Product" value={review.productTitle ?? review.productId} />
                <AttrRow label="Product ID" value={review.productId} />
                <AttrRow label="Handle" value={review.productHandle} />
                <AttrRow label="Variant" value={review.variantTitle} />
                <AttrRow
                  label="Language"
                  value={LOCALE_LABELS[review.language] ?? review.language}
                />
                <AttrRow label="Country" value={review.country} />
                <AttrRow label="Author email" value={review.authorEmail} />
                <AttrRow label="Customer ID" value={review.customerId} />
                <AttrRow label="Source" value={sourceLabel(review.source)} />
                <AttrRow label="Submitted" value={formatDateTime(review.createdAt)} />
                <AttrRow label="Last updated" value={formatDateTime(review.updatedAt)} />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <ConfirmationModal
        open={deleteOpen}
        title="Delete this review?"
        message="This permanently removes the review, its media references, votes and cached translations. Product ratings and metafields will be recalculated. This cannot be undone."
        confirmLabel="Delete review"
        loading={statusFetcher.state !== "idle" && statusFetcher.formData?.get("intent") === "delete"}
        onConfirm={() => statusFetcher.submit({ intent: "delete" }, { method: "post" })}
        onCancel={() => setDeleteOpen(false)}
      />
    </Page>
  );
}
