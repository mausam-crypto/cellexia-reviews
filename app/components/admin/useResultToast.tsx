import { useEffect, useRef } from "react";
import { useAppBridge } from "@shopify/app-bridge-react";

export interface ActionResult {
  ok: boolean;
  message?: string;
}

interface FetcherLike {
  state: string;
  data?: unknown;
}

/**
 * Shows an App Bridge toast when a fetcher action settles with `{ ok, message }` data.
 * Errors (`ok: false`) render as error toasts. `onSuccess` fires once per successful result.
 */
export function useResultToast(fetcher: FetcherLike, onSuccess?: () => void) {
  const shopify = useAppBridge();
  const lastHandled = useRef<unknown>(null);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || fetcher.data === lastHandled.current) {
      return;
    }
    lastHandled.current = fetcher.data;
    const result = fetcher.data as Partial<ActionResult>;
    if (typeof result.message === "string" && result.message.length > 0) {
      shopify.toast.show(result.message, result.ok ? undefined : { isError: true });
    }
    if (result.ok && onSuccess) {
      onSuccess();
    }
  }, [fetcher.state, fetcher.data, onSuccess, shopify]);
}
