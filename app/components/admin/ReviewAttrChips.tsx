import { Text } from "@shopify/polaris";
import {
  AGE_RANGE_LABELS,
  RESULTS_SEEN_LABELS,
  SKIN_CONCERN_LABELS,
  TIME_USING_LABELS,
  labelFor,
  labelsFor,
  parseKeyArray,
} from "./labels";

export interface ReviewAttrChipsProps {
  ageRange?: string | null;
  /** JSON string (DB column) or already-parsed array of SKIN_CONCERNS keys. */
  skinConcerns?: string | string[] | null;
  timeUsing?: string | null;
  /** JSON string (DB column) or already-parsed array of RESULTS_SEEN keys. */
  resultsSeen?: string | string[] | null;
  /** Single truncated line for table cells. */
  compact?: boolean;
}

/**
 * Renders the structured review answers as a muted one-line summary, e.g.
 * `Age: 45–54 · Skin: Fine lines & wrinkles, Dryness · Using: 1–3 months · Results: Smoother texture`.
 */
export function ReviewAttrChips({
  ageRange,
  skinConcerns,
  timeUsing,
  resultsSeen,
  compact = false,
}: ReviewAttrChipsProps) {
  const segments: string[] = [];

  const age = labelFor(ageRange, AGE_RANGE_LABELS);
  if (age) segments.push(`Age: ${age}`);

  const skin = labelsFor(parseKeyArray(skinConcerns), SKIN_CONCERN_LABELS);
  if (skin.length) segments.push(`Skin: ${skin.join(", ")}`);

  const time = labelFor(timeUsing, TIME_USING_LABELS);
  if (time) segments.push(`Using: ${time}`);

  const results = labelsFor(parseKeyArray(resultsSeen), RESULTS_SEEN_LABELS);
  if (results.length) segments.push(`Results: ${results.join(", ")}`);

  if (!segments.length) {
    return compact ? (
      <Text as="span" variant="bodySm" tone="subdued">
        —
      </Text>
    ) : null;
  }

  const line = segments.join(" · ");

  if (compact) {
    return (
      <span
        title={line}
        style={{
          display: "inline-block",
          maxWidth: 260,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          verticalAlign: "bottom",
        }}
      >
        <Text as="span" variant="bodySm" tone="subdued">
          {line}
        </Text>
      </span>
    );
  }

  return (
    <Text as="span" variant="bodySm" tone="subdued">
      {line}
    </Text>
  );
}
