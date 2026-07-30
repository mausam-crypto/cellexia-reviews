/**
 * Amazon-style star row for the Polaris admin. Supports fractional ratings via a
 * clipped orange overlay on top of a gray base row.
 */

const STAR_PATH =
  "M12 1.9l2.98 6.05 6.68.97-4.83 4.71 1.14 6.65L12 17.14l-5.97 3.14 1.14-6.65-4.83-4.71 6.68-.97L12 1.9z";

function StarRow({ size, color }: { size: number; color: string }) {
  return (
    <span style={{ display: "inline-flex", color, lineHeight: 0 }}>
      {[0, 1, 2, 3, 4].map((i) => (
        <svg
          key={i}
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
          focusable="false"
          style={{ flex: "0 0 auto" }}
        >
          <path d={STAR_PATH} />
        </svg>
      ))}
    </span>
  );
}

export interface StarRatingProps {
  /** Rating between 0 and 5 (fractional values render a partial fill). */
  rating: number;
  /** Star size in px. Default 16. */
  size?: number;
  /** Render the numeric value (1 decimal) next to the stars. */
  showValue?: boolean;
}

export function StarRating({ rating, size = 16, showValue = false }: StarRatingProps) {
  const clamped = Math.max(0, Math.min(5, Number.isFinite(rating) ? rating : 0));
  const percent = (clamped / 5) * 100;
  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6, verticalAlign: "middle" }}
    >
      <span
        role="img"
        aria-label={`${clamped.toFixed(1)} out of 5 stars`}
        style={{ position: "relative", display: "inline-flex", lineHeight: 0 }}
      >
        <StarRow size={size} color="#D5D9D9" />
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            insetInlineStart: 0,
            insetBlockStart: 0,
            overflow: "hidden",
            width: `${percent}%`,
            display: "inline-flex",
            lineHeight: 0,
            whiteSpace: "nowrap",
          }}
        >
          <StarRow size={size} color="#FF6200" />
        </span>
      </span>
      {showValue ? (
        <span style={{ fontWeight: 600, fontSize: Math.max(12, size - 2) }}>
          {clamped.toFixed(1)}
        </span>
      ) : null}
    </span>
  );
}
