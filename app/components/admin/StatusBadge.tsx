import { Badge } from "@shopify/polaris";
import type { BadgeProps } from "@shopify/polaris";
import { STATUS_LABELS } from "./labels";

const STATUS_TONES: Record<string, BadgeProps["tone"]> = {
  PENDING: "attention",
  PUBLISHED: "success",
  REJECTED: "critical",
  SPAM: "warning",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status] ?? status}</Badge>;
}
