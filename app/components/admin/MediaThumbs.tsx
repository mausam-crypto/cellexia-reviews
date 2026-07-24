import type { CSSProperties } from "react";
import { InlineStack, Text } from "@shopify/polaris";

export interface AdminMediaItem {
  id: string;
  /** "IMAGE" | "VIDEO" */
  type: string;
  url?: string | null;
  thumbUrl?: string | null;
}

export interface MediaThumbsProps {
  media: AdminMediaItem[];
  /** Square tile size in px. Default 64. */
  size?: number;
}

const tileStyle = (size: number): CSSProperties => ({
  width: size,
  height: size,
  borderRadius: 8,
  border: "1px solid #D5D9D9",
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#F6F6F7",
  position: "relative",
  flex: "0 0 auto",
});

function Tile({ item, size }: { item: AdminMediaItem; size: number }) {
  const src = item.thumbUrl || item.url || null;
  const isVideo = item.type === "VIDEO";
  const inner = (
    <span style={tileStyle(size)}>
      {src && !isVideo ? (
        <img
          src={src}
          alt="Review media"
          loading="lazy"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : isVideo ? (
        <>
          {src ? (
            <img
              src={src}
              alt="Review video"
              loading="lazy"
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          ) : (
            <span
              style={{
                position: "absolute",
                inset: 0,
                background: "#1A1A1A",
              }}
            />
          )}
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              insetInlineStart: "50%",
              insetBlockStart: "50%",
              transform: "translate(-50%, -50%)",
              width: 0,
              height: 0,
              borderTop: `${size / 8}px solid transparent`,
              borderBottom: `${size / 8}px solid transparent`,
              borderInlineStart: `${size / 5}px solid #FFFFFF`,
              filter: "drop-shadow(0 1px 2px rgba(0,0,0,.5))",
            }}
          />
          <span
            style={{
              position: "absolute",
              insetBlockEnd: 2,
              insetInlineStart: 4,
              fontSize: 10,
              fontWeight: 700,
              color: "#FFFFFF",
              textShadow: "0 1px 2px rgba(0,0,0,.6)",
            }}
          >
            Video
          </span>
        </>
      ) : (
        <span style={{ fontSize: 10, color: "#6D7175", textAlign: "center", padding: 4 }}>
          Processing…
        </span>
      )}
    </span>
  );

  if (item.url) {
    return (
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={isVideo ? "Open review video in a new tab" : "Open review image in a new tab"}
        style={{ display: "inline-block", lineHeight: 0 }}
      >
        {inner}
      </a>
    );
  }
  return inner;
}

/** Row of square media thumbnails for review images/videos in the admin. */
export function MediaThumbs({ media, size = 64 }: MediaThumbsProps) {
  if (!media.length) {
    return (
      <Text as="span" variant="bodySm" tone="subdued">
        No media
      </Text>
    );
  }
  return (
    <InlineStack gap="200" wrap>
      {media.map((item) => (
        <Tile key={item.id} item={item} size={size} />
      ))}
    </InlineStack>
  );
}
