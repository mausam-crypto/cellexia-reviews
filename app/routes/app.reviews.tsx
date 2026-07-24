import { useCallback, useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Outlet,
  useFetcher,
  useLoaderData,
  useNavigate,
  useNavigation,
  useParams,
  useSearchParams,
} from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Card,
  ChoiceList,
  IndexFilters,
  IndexTable,
  InlineStack,
  Page,
  Text,
  useIndexResourceState,
  useSetIndexFiltersMode,
  IndexFiltersMode,
} from "@shopify/polaris";
import type { IndexFiltersProps } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import { REVIEW_SOURCES } from "~/types/cellexia";
import type { ReviewSource } from "~/types/cellexia";
import {
  deleteReviews,
  updateReviewStatuses,
} from "~/components/admin/moderation.server";
import { StarRating } from "~/components/admin/StarRating";
import { StatusBadge } from "~/components/admin/StatusBadge";
import { ReviewAttrChips } from "~/components/admin/ReviewAttrChips";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, pluralize } from "~/components/admin/labels";

const PER_PAGE = 25;

const TAB_IDS = ["all", "pending", "published", "rejected", "spam"] as const;
const TAB_STATUS: Record<string, string | null> = {
  all: null,
  pending: "PENDING",
  published: "PUBLISHED",
  rejected: "REJECTED",
  spam: "SPAM",
};

const SORT_ORDERS: Record<string, { createdAt?: "asc" | "desc"; rating?: "asc" | "desc"; helpfulCount?: "asc" | "desc" }> = {
  "date desc": { createdAt: "desc" },
  "date asc": { createdAt: "asc" },
  "rating desc": { rating: "desc" },
  "rating asc": { rating: "asc" },
  "helpful desc": { helpfulCount: "desc" },
};

/** Admin labels for Review.source values (a NULL column counts as "storefront"). */
const SOURCE_LABELS: Record<ReviewSource, string> = {
  storefront: "Storefront",
  "csv-import": "CSV import",
  "bulk-add": "Bulk add",
  synthetic: "Synthetic",
};

/** Validates a raw ?source= query value against REVIEW_SOURCES; anything else → null. */
function parseSourceParam(value: string | null): ReviewSource | null {
  return value && (REVIEW_SOURCES as readonly string[]).includes(value)
    ? (value as ReviewSource)
    : null;
}

const emptyPayload = {
  reviews: [] as ReviewListItem[],
  total: 0,
  page: 1,
  totalPages: 0,
  counts: { all: 0, PENDING: 0, PUBLISHED: 0, REJECTED: 0, SPAM: 0 },
};

interface ReviewListItem {
  id: string;
  rating: number;
  title: string | null;
  excerpt: string;
  authorName: string;
  verified: boolean;
  productTitle: string | null;
  status: string;
  reportCount: number;
  ageRange: string | null;
  skinConcerns: string;
  timeUsing: string | null;
  resultsSeen: string;
  createdAt: string | Date;
  mediaCount: number;
  isSynthetic: boolean;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  // This route is also the layout for app.reviews.$id — skip the list work there.
  if (params.id) {
    return json(emptyPayload);
  }

  const url = new URL(request.url);
  const tab = TAB_IDS.includes((url.searchParams.get("tab") ?? "all") as (typeof TAB_IDS)[number])
    ? (url.searchParams.get("tab") ?? "all")
    : "all";
  const q = (url.searchParams.get("q") ?? "").trim();
  const reported = url.searchParams.get("reported") === "1";
  const source = parseSourceParam(url.searchParams.get("source"));
  const batch = (url.searchParams.get("batch") ?? "").trim();
  const sort = SORT_ORDERS[url.searchParams.get("sort") ?? ""] ? url.searchParams.get("sort")! : "date desc";
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

  const status = TAB_STATUS[tab];
  const where = {
    shop,
    ...(status ? { status } : {}),
    ...(reported ? { reportCount: { gt: 0 } } : {}),
    ...(batch ? { syntheticBatchId: batch } : {}),
    // "storefront" also matches a NULL source — rows created before v1.4
    // predate source tracking and were all storefront submissions.
    ...(source
      ? source === "storefront"
        ? { OR: [{ source: "storefront" }, { source: null }] }
        : { source }
      : {}),
    // Wrapped in AND so the text-search OR never collides with the source OR.
    ...(q
      ? {
          AND: [
            {
              OR: [
                { title: { contains: q } },
                { body: { contains: q } },
                { authorName: { contains: q } },
                { productTitle: { contains: q } },
              ],
            },
          ],
        }
      : {}),
  };

  const [rows, total, allCount, pendingCount, publishedCount, rejectedCount, spamCount] =
    await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: SORT_ORDERS[sort],
        take: PER_PAGE,
        skip: (page - 1) * PER_PAGE,
        include: { _count: { select: { media: true } } },
      }),
      prisma.review.count({ where }),
      prisma.review.count({ where: { shop } }),
      prisma.review.count({ where: { shop, status: "PENDING" } }),
      prisma.review.count({ where: { shop, status: "PUBLISHED" } }),
      prisma.review.count({ where: { shop, status: "REJECTED" } }),
      prisma.review.count({ where: { shop, status: "SPAM" } }),
    ]);

  return json({
    reviews: rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      excerpt: r.body.length > 110 ? `${r.body.slice(0, 110)}…` : r.body,
      authorName: r.authorName,
      verified: r.verified,
      productTitle: r.productTitle,
      status: r.status,
      reportCount: r.reportCount,
      ageRange: r.ageRange,
      skinConcerns: r.skinConcerns,
      timeUsing: r.timeUsing,
      resultsSeen: r.resultsSeen,
      createdAt: r.createdAt,
      mediaCount: r._count.media,
      isSynthetic: r.isSynthetic,
    })),
    total,
    page,
    totalPages: Math.max(1, Math.ceil(total / PER_PAGE)),
    counts: {
      all: allCount,
      PENDING: pendingCount,
      PUBLISHED: publishedCount,
      REJECTED: rejectedCount,
      SPAM: spamCount,
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  let ids: string[] = [];
  try {
    const parsed = JSON.parse(String(form.get("ids") ?? "[]"));
    if (Array.isArray(parsed)) {
      ids = parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    ids = [];
  }
  if (!ids.length) {
    return json({ ok: false, message: "No reviews selected" }, { status: 400 });
  }

  try {
    if (intent === "approve" || intent === "reject" || intent === "spam") {
      const status =
        intent === "approve" ? "PUBLISHED" : intent === "reject" ? "REJECTED" : "SPAM";
      const changed = await updateReviewStatuses(shop, ids, status, admin);
      const verb =
        intent === "approve" ? "approved" : intent === "reject" ? "rejected" : "marked as spam";
      return json({ ok: true, message: `${pluralize(changed, "review")} ${verb}` });
    }
    if (intent === "delete") {
      const deleted = await deleteReviews(shop, ids, admin);
      return json({ ok: true, message: `${pluralize(deleted, "review")} deleted` });
    }
    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Bulk review action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

export default function ReviewsRoute() {
  const params = useParams();
  if (params.id) {
    return <Outlet />;
  }
  return <ReviewsList />;
}

function ReviewsList() {
  const { reviews, total, page, totalPages, counts } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const fetcher = useFetcher<typeof action>();

  const tabParam = searchParams.get("tab") ?? "all";
  const reported = searchParams.get("reported") === "1";
  const sourceFilter = parseSourceParam(searchParams.get("source"));
  const batchFilter = (searchParams.get("batch") ?? "").trim();
  const sortParam = searchParams.get("sort") ?? "date desc";

  const [queryValue, setQueryValue] = useState(searchParams.get("q") ?? "");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { mode, setMode } = useSetIndexFiltersMode();

  const updateParams = useCallback(
    (patch: Record<string, string | null>) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === "") next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // Debounced search → URL.
  useEffect(() => {
    const current = searchParams.get("q") ?? "";
    if (queryValue === current) return;
    const timer = setTimeout(() => {
      updateParams({ q: queryValue || null, page: null });
    }, 350);
    return () => clearTimeout(timer);
  }, [queryValue, searchParams, updateParams]);

  const resourceName = { singular: "review", plural: "reviews" };
  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(reviews);

  useResultToast(fetcher, () => {
    clearSelection();
    setDeleteOpen(false);
  });

  const tabs = [
    { id: "all", content: `All (${counts.all})` },
    { id: "pending", content: `Pending (${counts.PENDING})` },
    { id: "published", content: `Published (${counts.PUBLISHED})` },
    { id: "rejected", content: `Rejected (${counts.REJECTED})` },
    { id: "spam", content: `Spam (${counts.SPAM})` },
  ];
  const selectedTab = Math.max(0, TAB_IDS.indexOf(tabParam as (typeof TAB_IDS)[number]));

  const sortOptions: IndexFiltersProps["sortOptions"] = [
    { label: "Date", value: "date desc", directionLabel: "Newest first" },
    { label: "Date", value: "date asc", directionLabel: "Oldest first" },
    { label: "Rating", value: "rating desc", directionLabel: "Highest first" },
    { label: "Rating", value: "rating asc", directionLabel: "Lowest first" },
    { label: "Helpful votes", value: "helpful desc", directionLabel: "Most first" },
  ];

  const filters = [
    {
      key: "source",
      label: "Source",
      filter: (
        <ChoiceList
          title="Source"
          titleHidden
          choices={REVIEW_SOURCES.map((value) => ({
            label: SOURCE_LABELS[value],
            value,
          }))}
          selected={sourceFilter ? [sourceFilter] : []}
          onChange={(value: string[]) =>
            updateParams({ source: value[0] ?? null, page: null })
          }
        />
      ),
      shortcut: true,
    },
    {
      key: "reported",
      label: "Flagged by shoppers",
      filter: (
        <ChoiceList
          title="Flagged by shoppers"
          titleHidden
          choices={[{ label: "Only reviews reported by shoppers", value: "1" }]}
          selected={reported ? ["1"] : []}
          onChange={(value: string[]) =>
            updateParams({ reported: value.includes("1") ? "1" : null, page: null })
          }
        />
      ),
      shortcut: true,
    },
  ];

  const appliedFilters: NonNullable<IndexFiltersProps["appliedFilters"]> = [];
  if (sourceFilter) {
    appliedFilters.push({
      key: "source",
      label: `Source: ${SOURCE_LABELS[sourceFilter]}`,
      onRemove: () => updateParams({ source: null, page: null }),
    });
  }
  if (batchFilter) {
    // Batch ids are UUIDs — the chip shows the short prefix used everywhere
    // in the admin (QA data page, review detail banner).
    appliedFilters.push({
      key: "batch",
      label: `Batch: ${batchFilter.slice(0, 8)}`,
      onRemove: () => updateParams({ batch: null, page: null }),
    });
  }
  if (reported) {
    appliedFilters.push({
      key: "reported",
      label: "Flagged by shoppers",
      onRemove: () => updateParams({ reported: null, page: null }),
    });
  }

  const bulk = (intent: "approve" | "reject" | "spam") => {
    fetcher.submit(
      { intent, ids: JSON.stringify(selectedResources) },
      { method: "post" },
    );
  };

  const promotedBulkActions = [
    { content: "Approve", onAction: () => bulk("approve") },
    { content: "Reject", onAction: () => bulk("reject") },
    { content: "Mark as spam", onAction: () => bulk("spam") },
  ];
  const bulkActions = [{ content: "Delete", onAction: () => setDeleteOpen(true) }];

  const rowMarkup = reviews.map((review, index) => (
    <IndexTable.Row
      id={review.id}
      key={review.id}
      selected={selectedResources.includes(review.id)}
      position={index}
      onClick={() => navigate(`/app/reviews/${review.id}`)}
    >
      <IndexTable.Cell>
        <StarRating rating={review.rating} size={14} />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="span" fontWeight="semibold">
            {review.title || "Untitled review"}
          </Text>
          <Text as="span" variant="bodySm" tone="subdued">
            {review.excerpt}
          </Text>
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack gap="050">
          <Text as="span">{review.authorName}</Text>
          {review.verified ? (
            <Text as="span" variant="bodySm" tone="subdued">
              Verified purchase
            </Text>
          ) : null}
        </BlockStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">
          {review.productTitle ?? "—"}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <ReviewAttrChips
          ageRange={review.ageRange}
          skinConcerns={review.skinConcerns}
          timeUsing={review.timeUsing}
          resultsSeen={review.resultsSeen}
          compact
        />
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="100" blockAlign="center" wrap={false}>
          <StatusBadge status={review.status} />
          {review.isSynthetic ? <Badge tone="info">Synthetic</Badge> : null}
          {review.reportCount > 0 ? (
            <Badge tone="critical">{pluralize(review.reportCount, "report")}</Badge>
          ) : null}
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">
          {formatDate(review.createdAt)}
        </Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm" tone="subdued">
          {review.mediaCount > 0 ? review.mediaCount : "—"}
        </Text>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page title="Reviews" fullWidth>
      <TitleBar title="Reviews" />
      <BlockStack gap="400">
        <Card padding="0">
          <IndexFilters
            tabs={tabs}
            selected={selectedTab}
            onSelect={(index) => {
              clearSelection();
              updateParams({
                tab: TAB_IDS[index] === "all" ? null : TAB_IDS[index],
                page: null,
              });
            }}
            sortOptions={sortOptions}
            sortSelected={[sortParam]}
            onSort={(value) => updateParams({ sort: value[0] ?? null, page: null })}
            queryValue={queryValue}
            queryPlaceholder="Search title, body, author or product"
            onQueryChange={setQueryValue}
            onQueryClear={() => setQueryValue("")}
            filters={filters}
            appliedFilters={appliedFilters}
            onClearAll={() => {
              setQueryValue("");
              updateParams({ q: null, reported: null, source: null, batch: null, page: null });
            }}
            mode={mode}
            setMode={setMode}
            canCreateNewView={false}
            loading={navigation.state === "loading"}
            cancelAction={{ onAction: () => setMode(IndexFiltersMode.Default) }}
          />
          <IndexTable
            resourceName={resourceName}
            itemCount={reviews.length}
            selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
            onSelectionChange={handleSelectionChange}
            promotedBulkActions={promotedBulkActions}
            bulkActions={bulkActions}
            headings={[
              { title: "Rating" },
              { title: "Review" },
              { title: "Author" },
              { title: "Product" },
              { title: "Details" },
              { title: "Status" },
              { title: "Date" },
              { title: "Media" },
            ]}
            pagination={{
              hasNext: page < totalPages,
              hasPrevious: page > 1,
              onNext: () => updateParams({ page: String(page + 1) }),
              onPrevious: () => updateParams({ page: page - 1 <= 1 ? null : String(page - 1) }),
            }}
            emptyState={
              <Card>
                <BlockStack gap="200" inlineAlign="center">
                  <Text as="p" variant="headingSm">
                    No reviews found
                  </Text>
                  <Text as="p" tone="subdued">
                    Reviews submitted on your storefront — or imported from a CSV, added in
                    bulk, or generated as QA data — appear here for moderation.
                  </Text>
                </BlockStack>
              </Card>
            }
          >
            {rowMarkup}
          </IndexTable>
        </Card>
        {total > 0 ? (
          <Text as="p" variant="bodySm" tone="subdued" alignment="center">
            Showing {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, total)} of{" "}
            {pluralize(total, "review")}
          </Text>
        ) : null}
      </BlockStack>

      <ConfirmationModal
        open={deleteOpen}
        title={`Delete ${pluralize(selectedResources.length, "review")}?`}
        message="This permanently removes the selected reviews, their media references, votes and cached translations. Product ratings and metafields will be recalculated. This cannot be undone."
        confirmLabel="Delete"
        loading={fetcher.state !== "idle"}
        onConfirm={() =>
          fetcher.submit(
            { intent: "delete", ids: JSON.stringify(selectedResources) },
            { method: "post" },
          )
        }
        onCancel={() => setDeleteOpen(false)}
      />
    </Page>
  );
}
