/**
 * Cellexia Reviews — review media uploads via Shopify Files.
 *
 * `uploadReviewMedia` runs the full staged-upload flow for one file:
 *   stagedUploadsCreate → POST the bytes to the staged target → fileCreate →
 *   brief READY/FAILED poll. It returns the created File GID; CDN URLs are
 *   usually not available immediately, so `resolveMediaUrls` is called later
 *   (e.g. on listing/moderation) to fill in `url`/`thumbUrl` on ReviewMedia
 *   rows once Shopify has finished processing.
 *
 * uploadReviewMedia throws descriptive Errors (the submit route maps them to a
 * media validation error for the visitor); resolveMediaUrls is best-effort and
 * never throws.
 */
import type { AdminApiContext as BaseAdminApiContext } from "@shopify/shopify-app-remix/server";

/**
 * Admin client accepted by this module. The app enables `future.removeRest`
 * (app/shopify.server.ts), so `authenticate.admin` yields
 * `AdminApiContextWithoutRest`, which the package's `/server` entry does not
 * re-export. This module only uses `graphql`, so accept exactly that —
 * contexts with and without REST both satisfy it structurally.
 */
type AdminApiContext = Pick<BaseAdminApiContext, "graphql">;
import prisma from "~/db.server";

const STAGED_UPLOADS_CREATE = `#graphql
  mutation CellexiaStagedUploadsCreate($input: [StagedUploadInput!]!) {
    stagedUploadsCreate(input: $input) {
      stagedTargets {
        url
        resourceUrl
        parameters {
          name
          value
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FILE_CREATE = `#graphql
  mutation CellexiaFileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files {
        id
        fileStatus
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const FILE_STATUS_QUERY = `#graphql
  query CellexiaFileStatus($id: ID!) {
    node(id: $id) {
      ... on File {
        fileStatus
      }
    }
  }
`;

const FILES_QUERY = `#graphql
  query CellexiaFiles($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on MediaImage {
        id
        fileStatus
        image {
          url
          thumb: url(transform: { maxWidth: 360, maxHeight: 360 })
        }
      }
      ... on Video {
        id
        fileStatus
        preview {
          image {
            url
          }
        }
        sources {
          url
          format
          mimeType
        }
      }
      ... on GenericFile {
        id
        fileStatus
        url
      }
    }
  }
`;

/**
 * Uploads one review media file (already validated by the proxy route: magic
 * bytes, size caps, count caps) to Shopify Files and returns the File GID.
 */
export async function uploadReviewMedia(
  admin: AdminApiContext,
  file: File,
  type: "IMAGE" | "VIDEO",
): Promise<{ fileGid: string }> {
  const resource = type === "VIDEO" ? "VIDEO" : "IMAGE";
  const filename = safeFilename(file.name, type);
  const mimeType = file.type || (type === "VIDEO" ? "video/mp4" : "image/jpeg");

  // 1. Reserve a staged upload target.
  const stagedResponse = await admin.graphql(STAGED_UPLOADS_CREATE, {
    variables: {
      input: [
        {
          filename,
          mimeType,
          resource,
          httpMethod: "POST",
          fileSize: String(file.size),
        },
      ],
    },
  });
  const stagedJson = (await stagedResponse.json()) as {
    data?: {
      stagedUploadsCreate?: {
        stagedTargets?: Array<{
          url?: string;
          resourceUrl?: string;
          parameters?: Array<{ name: string; value: string }>;
        }>;
        userErrors?: Array<{ message?: string }>;
      };
    };
  };
  const stagedErrors = stagedJson.data?.stagedUploadsCreate?.userErrors ?? [];
  if (stagedErrors.length > 0) {
    throw new Error(
      `staged_upload_failed: ${stagedErrors.map((e) => e.message).join("; ")}`,
    );
  }
  const target = stagedJson.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target.resourceUrl) {
    throw new Error("staged_upload_failed: no staged target returned");
  }

  // 2. POST the bytes to the staged target (parameters first, file last).
  const form = new FormData();
  for (const parameter of target.parameters ?? []) {
    form.append(parameter.name, parameter.value);
  }
  form.append("file", file, filename);
  const uploadResponse = await fetch(target.url, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    throw new Error(`staged_upload_failed: upload returned ${uploadResponse.status}`);
  }

  // 3. Create the file from the staged resource URL.
  const createResponse = await admin.graphql(FILE_CREATE, {
    variables: {
      files: [
        {
          originalSource: target.resourceUrl,
          contentType: resource,
          alt: "Customer review media",
        },
      ],
    },
  });
  const createJson = (await createResponse.json()) as {
    data?: {
      fileCreate?: {
        files?: Array<{ id?: string; fileStatus?: string }>;
        userErrors?: Array<{ message?: string }>;
      };
    };
  };
  const createErrors = createJson.data?.fileCreate?.userErrors ?? [];
  if (createErrors.length > 0) {
    throw new Error(`file_create_failed: ${createErrors.map((e) => e.message).join("; ")}`);
  }
  const created = createJson.data?.fileCreate?.files?.[0];
  if (!created?.id) {
    throw new Error("file_create_failed: no file returned");
  }

  // 4. Poll briefly for processing; resolveMediaUrls fills URLs later if the
  //    file is still processing when we give up here.
  let status = created.fileStatus ?? "PROCESSING";
  for (let attempt = 0; attempt < 5 && status !== "READY" && status !== "FAILED"; attempt += 1) {
    await sleep(800);
    status = await queryFileStatus(admin, created.id);
  }
  if (status === "FAILED") {
    throw new Error("file_create_failed: Shopify reported FAILED processing");
  }

  return { fileGid: created.id };
}

/**
 * Fills `url`/`thumbUrl` on ReviewMedia rows (by row id) whose CDN URLs are
 * still missing, by querying the underlying Shopify Files. Best-effort — rows
 * whose files are still processing are simply left for a later call.
 */
export async function resolveMediaUrls(
  admin: AdminApiContext,
  mediaIds: string[],
): Promise<void> {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) return;

  try {
    const rows = await prisma.reviewMedia.findMany({
      where: {
        id: { in: mediaIds },
        fileGid: { not: null },
        OR: [{ url: null }, { thumbUrl: null }],
      },
    });
    if (rows.length === 0) return;

    const gids = [...new Set(rows.map((row) => row.fileGid as string))];
    const response = await admin.graphql(FILES_QUERY, { variables: { ids: gids } });
    const json = (await response.json()) as {
      data?: { nodes?: Array<Record<string, unknown> | null> };
      errors?: unknown;
    };
    if (json.errors) {
      console.error("[cellexia] resolveMediaUrls query errors:", json.errors);
      return;
    }

    const urlsByGid = new Map<string, { url: string; thumbUrl: string | null }>();
    for (const node of json.data?.nodes ?? []) {
      if (!node || typeof node.id !== "string") continue;
      const resolved = extractUrls(node);
      if (resolved) urlsByGid.set(node.id, resolved);
    }

    for (const row of rows) {
      const resolved = urlsByGid.get(row.fileGid as string);
      if (!resolved) continue;
      try {
        await prisma.reviewMedia.update({
          where: { id: row.id },
          data: {
            url: row.url ?? resolved.url,
            thumbUrl: row.thumbUrl ?? resolved.thumbUrl ?? resolved.url,
          },
        });
      } catch (error) {
        console.error(`[cellexia] resolveMediaUrls update failed for ${row.id}`, error);
      }
    }
  } catch (error) {
    console.error("[cellexia] resolveMediaUrls failed", error);
  }
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

function extractUrls(node: Record<string, unknown>): { url: string; thumbUrl: string | null } | null {
  // MediaImage
  const image = node.image as { url?: string; thumb?: string } | null | undefined;
  if (image?.url) {
    return { url: image.url, thumbUrl: image.thumb ?? image.url };
  }

  // Video — prefer an mp4 source, fall back to the first source.
  const sources = node.sources as
    | Array<{ url?: string; format?: string; mimeType?: string }>
    | undefined;
  if (Array.isArray(sources) && sources.length > 0) {
    const mp4 = sources.find(
      (source) =>
        source.format === "mp4" || (source.mimeType ?? "").toLowerCase().includes("mp4"),
    );
    const url = (mp4 ?? sources[0]).url;
    if (url) {
      const preview = node.preview as { image?: { url?: string } } | null | undefined;
      return { url, thumbUrl: preview?.image?.url ?? null };
    }
  }

  // GenericFile
  if (typeof node.url === "string" && node.url) {
    return { url: node.url, thumbUrl: node.url };
  }

  return null;
}

async function queryFileStatus(admin: AdminApiContext, fileGid: string): Promise<string> {
  try {
    const response = await admin.graphql(FILE_STATUS_QUERY, { variables: { id: fileGid } });
    const json = (await response.json()) as {
      data?: { node?: { fileStatus?: string } | null };
    };
    return json.data?.node?.fileStatus ?? "PROCESSING";
  } catch (error) {
    console.error("[cellexia] file status poll failed", error);
    return "PROCESSING";
  }
}

function safeFilename(name: string | undefined, type: "IMAGE" | "VIDEO"): string {
  const fallback = type === "VIDEO" ? "review-video.mp4" : "review-image.jpg";
  const raw = (name ?? "").trim() || fallback;
  const cleaned = raw.replace(/[^\w.\-]+/g, "_");
  // Keep the tail so the extension survives very long names.
  return cleaned.length > 100 ? cleaned.slice(-100) : cleaned;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
