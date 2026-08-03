import type { CSSProperties } from "react";
import { useCallback, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  FormLayout,
  InlineStack,
  Layout,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import type { DesignTheme } from "~/types/cellexia";
import { DESIGN_THEMES, TRANSLATION_DISPLAYS } from "~/types/cellexia";
import { getSettings, updateSettings } from "~/services/settings.server";
import { syncShopSettingsMetafields } from "~/services/metafields.server";
import { generateSummary, verifyAnthropicKey } from "~/services/ai.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { ConfirmationModal } from "~/components/admin/ConfirmationModal";
import { useResultToast } from "~/components/admin/useResultToast";

const AI_PROVIDERS = ["anthropic", "off"] as const;
const AI_MODELS = ["claude-sonnet-5", "claude-haiku-4-5"] as const;
const TRANSLATION_PROVIDERS = ["anthropic", "deepl", "google", "off"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await getSettings(session.shop);

  return json({
    settings: {
      isLive: settings.isLive,
      brandDisplayName: settings.brandDisplayName,
      autoPublish: settings.autoPublish,
      notifyEmail: settings.notifyEmail ?? "",
      aiProvider: settings.aiProvider,
      aiModel: settings.aiModel,
      summaryAutoThreshold: settings.summaryAutoThreshold,
      translationProvider: settings.translationProvider,
      translationDisplay: settings.translationDisplay,
      showTranslate: settings.showTranslate,
      showSummary: settings.showSummary,
      showQna: settings.showQna,
      showMediaStrip: settings.showMediaStrip,
      emitJsonLd: settings.emitJsonLd,
      reviewsPerPage: settings.reviewsPerPage,
      designTheme: settings.designTheme,
      hasAnthropicKey: Boolean(settings.anthropicApiKey),
      // Last 4 characters only — enough to recognize which key is saved,
      // never enough to reconstruct it. The full key never leaves the server.
      anthropicKeyHint: settings.anthropicApiKey ? settings.anthropicApiKey.slice(-4) : null,
      hasDeeplKey: Boolean(settings.deeplApiKey),
      hasGoogleKey: Boolean(settings.googleApiKey),
    },
  });
};

function clampInt(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const str = (key: string) => String(form.get(key) ?? "").trim();

  try {
    if (intent === "save") {
      const aiProvider = str("aiProvider");
      const aiModel = str("aiModel");
      const translationProvider = str("translationProvider");
      const translationDisplay = str("translationDisplay");
      const designTheme = str("designTheme");

      const patch: Record<string, unknown> = {
        brandDisplayName: str("brandDisplayName") || "Cellexia",
        autoPublish: form.get("autoPublish") === "true",
        notifyEmail: str("notifyEmail") || null,
        aiProvider: (AI_PROVIDERS as readonly string[]).includes(aiProvider)
          ? aiProvider
          : "anthropic",
        aiModel: (AI_MODELS as readonly string[]).includes(aiModel)
          ? aiModel
          : "claude-sonnet-5",
        summaryAutoThreshold: clampInt(str("summaryAutoThreshold"), 5, 1, 100),
        translationProvider: (TRANSLATION_PROVIDERS as readonly string[]).includes(
          translationProvider,
        )
          ? translationProvider
          : "anthropic",
        // v1.8 (SPEC-1.8 §4): how reviews written in another language are
        // displayed — "original" (Translate button) or "translated"
        // (auto-translated with a "See original" toggle).
        translationDisplay: (TRANSLATION_DISPLAYS as readonly string[]).includes(
          translationDisplay,
        )
          ? translationDisplay
          : "original",
        showTranslate: form.get("showTranslate") === "true",
        showSummary: form.get("showSummary") === "true",
        showQna: form.get("showQna") === "true",
        showMediaStrip: form.get("showMediaStrip") === "true",
        emitJsonLd: form.get("emitJsonLd") === "true",
        reviewsPerPage: clampInt(str("reviewsPerPage"), 10, 1, 50),
        designTheme: (DESIGN_THEMES as readonly string[]).includes(designTheme)
          ? designTheme
          : "amazon",
      };

      // API keys: an empty field keeps the stored key.
      const anthropicApiKey = str("anthropicApiKey");
      if (anthropicApiKey) patch.anthropicApiKey = anthropicApiKey;
      const deeplApiKey = str("deeplApiKey");
      if (deeplApiKey) patch.deeplApiKey = deeplApiKey;
      const googleApiKey = str("googleApiKey");
      if (googleApiKey) patch.googleApiKey = googleApiKey;

      const saved = await updateSettings(shop, patch as Parameters<typeof updateSettings>[1]);
      // Mirror the storefront-relevant settings onto shop metafields so the
      // theme extension (Liquid) can honor them without a DB round-trip. The
      // full saved row is passed so isLive (cellexia.live) rides along too.
      await syncShopSettingsMetafields(admin, saved);
      return json({ ok: true, message: "Settings saved" });
    }

    if (intent === "test-anthropic-key") {
      // Tests the key typed into the field (before saving) or, when the field
      // is blank, the stored key — via the free count_tokens endpoint.
      const typed = str("anthropicApiKey");
      const settings = await getSettings(shop);
      const key = typed || settings.anthropicApiKey;
      if (!key) {
        return json({ ok: false, message: "No key to test — paste a key first (or save one)." });
      }
      const formModel = str("aiModel");
      const model = (AI_MODELS as readonly string[]).includes(formModel)
        ? formModel
        : settings.aiModel;
      const which = typed ? "The key you entered" : "The saved key";
      const result = await verifyAnthropicKey(key, model);
      switch (result.status) {
        case "ok":
          return json({ ok: true, message: `${which} works — ${model} is reachable.` });
        case "invalid_key":
          return json({ ok: false, message: `${which} was rejected by Anthropic (401). Check for typos or a revoked key.` });
        case "forbidden":
          return json({ ok: false, message: `${which} was refused (403) — it may lack API access. Check the key's permissions at console.anthropic.com.` });
        case "model_missing":
          return json({ ok: false, message: `${which} is valid, but the model ${model} is not available on that account.` });
        default:
          return json({ ok: false, message: `Could not verify the key: ${result.detail}` });
      }
    }

    if (intent === "remove-anthropic-key") {
      // Explicit removal — the save flow deliberately treats an empty field as
      // "keep the saved key", so removal needs its own intent.
      await updateSettings(shop, { anthropicApiKey: "" });
      return json({
        ok: true,
        message:
          "Claude API key removed. AI summaries, the QA generator and Claude translations are paused until a new key is saved.",
      });
    }

    if (intent === "regen-preview-token") {
      // A fresh token invalidates every previously shared preview link. The
      // storefront preview flow reads Setting.previewToken (SPEC-1.2).
      const previewToken = crypto.randomUUID();
      const saved = await prisma.setting.upsert({
        where: { shop },
        update: { previewToken },
        create: { shop, previewToken },
      });
      // SPEC-1.6 §3: the theme editor reads the token from the
      // `cellexia.preview_token` shop metafield, so the new token must reach
      // the metafield too. Without this the editor keeps sending the token we
      // just invalidated and every request answers 403 not_live ("Preview
      // session expired") until an unrelated settings save happens to fix it.
      await syncShopSettingsMetafields(admin, saved);
      return json({
        ok: true,
        message: "Preview link regenerated — old links no longer work.",
      });
    }

    if (intent === "regenerate-all") {
      const groups = await prisma.review.groupBy({
        by: ["productId"],
        where: { shop, status: "PUBLISHED" },
      });
      if (!groups.length) {
        return json({ ok: false, message: "No published reviews to summarize yet" });
      }
      let generated = 0;
      for (const group of groups) {
        try {
          const summary = await generateSummary(shop, group.productId, "en");
          if (summary) {
            await syncProductData(shop, group.productId, admin);
            generated += 1;
          }
        } catch (error) {
          console.error(`Summary generation failed for product ${group.productId}`, error);
        }
      }
      if (!generated) {
        return json({
          ok: false,
          message: "No summaries could be generated. Check the AI settings and API key.",
        });
      }
      return json({
        ok: true,
        message: `AI summaries regenerated for ${generated} of ${groups.length} products`,
      });
    }

    if (intent === "delete-all-data") {
      // v1.2 (SPEC-1.2): the Setting row carries the go-live state and
      // isLive defaults to false. Capture the current row before the wipe —
      // recreating it from schema defaults would silently flip a live store to
      // not-live (every proxy route answers 403 not_live, the widget hides)
      // while the `cellexia.live` shop metafield still said true. SPEC-1.6 §2
      // adds proxySubpath: its schema default is the shipped subpath, so a
      // store whose detected app-proxy path differs would get a 404 path
      // written into `cellexia.proxy_path`.
      const prev = await getSettings(shop);
      const reviewIds = (
        await prisma.review.findMany({ where: { shop }, select: { id: true } })
      ).map((r) => r.id);
      if (reviewIds.length) {
        await prisma.translationCache.deleteMany({ where: { reviewId: { in: reviewIds } } });
      }
      // ReviewMedia + Vote rows cascade with their reviews.
      await prisma.review.deleteMany({ where: { shop } });
      // v1.16 review fix: cached Q&A answers quote review text — the wipe
      // must reach them (and Summary rows already go via deleteMany below).
      await prisma.askAnswer.deleteMany({ where: { shop } });
      // v1.19: the brand page's analysis row (verbatim quotes + names) and
      // the per-product curations — both are review-derived content.
      await prisma.brandAnalysis.deleteMany({ where: { shop } });
      await prisma.aiCuration.deleteMany({ where: { shop } });
      // The brand page is SSR'd from a SHOP METAFIELD: clearing the database
      // alone would leave every deleted review still rendering publicly.
      // Republish from the (now empty) data before the Setting row goes.
      try {
        const { publishBrandPage } = await import("~/services/brand-page.server");
        await publishBrandPage(shop, admin);
      } catch (error) {
        console.error("[cellexia] brand-page clear after delete-all-data failed", error);
      }
      await prisma.summary.deleteMany({ where: { shop } });
      await prisma.setting.deleteMany({ where: { shop } });
      // Recreate the settings row with fresh defaults but keep the live state,
      // the detected app-proxy subpath AND (v1.14, review fix) the market
      // scope + Stamped-takeover state — recreating with defaults would
      // silently widen a markets-scoped live store to ALL markets (the exact
      // outcome SPEC-1.14 §0.1 forbids). Then re-sync the shop metafields so
      // the DB and every `cellexia.*` flag agree after the wipe.
      const keep = {
        isLive: prev.isLive,
        proxySubpath: prev.proxySubpath,
        liveScope: prev.liveScope,
        liveMarkets: prev.liveMarkets,
        hideStamped: prev.hideStamped,
        stampedSelectors: prev.stampedSelectors,
        observedMarkets: prev.observedMarkets,
      };
      await prisma.setting.upsert({
        where: { shop },
        update: keep,
        create: { shop, ...keep },
      });
      // Read back through getSettings, which mints a preview token when the
      // row has none: syncShopSettingsMetafields SKIPS `cellexia.preview_token`
      // for a null token, which would leave the metafield holding the token of
      // the deleted row while the next getSettings mints a different one —
      // permanent 403 not_live in the theme editor (SPEC-1.6 §3).
      const fresh = await getSettings(shop);
      await syncShopSettingsMetafields(admin, fresh);
      return json({
        ok: true,
        message: "All app data for this store has been deleted",
      });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Settings action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

/**
 * Compact inline preview for a design version: star row, primary pill button
 * and the verified-purchase treatment in that skin's storefront colors, so the
 * merchant sees the difference at a glance. Pure inline-styled elements — the
 * admin never loads the storefront CSS.
 */
function DesignPreviewSwatches({ theme }: { theme: DesignTheme }) {
  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: "10px",
    marginTop: "4px",
  };
  const starsStyle: CSSProperties = {
    color: theme === "amazon" ? "#FF6200" : theme === "luxe" ? "#C8A24B" : "#1D1D1B",
    fontSize: "14px",
    letterSpacing: "1px",
    lineHeight: 1,
  };
  const buttonStyle: CSSProperties =
    theme === "amazon"
      ? {
          background: "#FFD814",
          border: "1px solid #FCD200",
          borderRadius: "100px",
          color: "#0F1111",
          fontSize: "12px",
          lineHeight: 1,
          padding: "6px 14px",
        }
      : theme === "luxe"
        ? {
            // Luxe primary button: charcoal soft rectangle, sentence case
            // (SPEC-1.3 — radius 10px, NOT a pill).
            background: "#211E1C",
            border: "1px solid #211E1C",
            borderRadius: "10px",
            color: "#FFFFFF",
            fontSize: "12px",
            fontWeight: 600,
            lineHeight: 1,
            padding: "6px 14px",
          }
        : {
            background: "#1D1D1B",
            border: "1px solid #1D1D1B",
            borderRadius: "999px",
            color: "#FFFFFF",
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "1px",
            lineHeight: 1,
            padding: "6px 14px",
            textTransform: "uppercase",
          };
  const verifiedStyle: CSSProperties =
    theme === "amazon"
      ? {
          color: "#C45500",
          fontSize: "12px",
          fontWeight: 700,
          lineHeight: 1,
        }
      : theme === "luxe"
        ? {
            // Luxe verified chip: filled champagne (SPEC-1.3).
            background: "#F3EAD7",
            borderRadius: "6px",
            color: "#7A5F28",
            fontSize: "11px",
            fontWeight: 700,
            letterSpacing: "0.06em",
            lineHeight: 1,
            padding: "2px 8px",
            textTransform: "uppercase",
          }
        : {
            background: "#B1CDED",
            borderRadius: "999px",
            color: "#1D1D1B",
            fontSize: "11px",
            fontWeight: 600,
            letterSpacing: "0.06em",
            lineHeight: 1,
            padding: "2px 10px",
            textTransform: "uppercase",
          };
  return (
    <span style={rowStyle} aria-hidden="true">
      <span style={starsStyle}>★★★★★</span>
      <span style={buttonStyle}>Submit review</span>
      <span style={verifiedStyle}>Verified Purchase</span>
    </span>
  );
}

export default function Settings() {
  const { settings } = useLoaderData<typeof loader>();

  const saveFetcher = useFetcher<typeof action>();
  const regenFetcher = useFetcher<typeof action>();
  const tokenFetcher = useFetcher<typeof action>();
  const deleteFetcher = useFetcher<typeof action>();
  const keyFetcher = useFetcher<typeof action>();

  const [deleteOpen, setDeleteOpen] = useState(false);

  useResultToast(saveFetcher);
  useResultToast(regenFetcher);
  useResultToast(tokenFetcher);
  useResultToast(deleteFetcher, () => setDeleteOpen(false));
  useResultToast(keyFetcher);

  const [form, setForm] = useState({
    brandDisplayName: settings.brandDisplayName,
    autoPublish: settings.autoPublish,
    notifyEmail: settings.notifyEmail,
    aiProvider: settings.aiProvider,
    aiModel: settings.aiModel,
    anthropicApiKey: "",
    summaryAutoThreshold: String(settings.summaryAutoThreshold),
    translationProvider: settings.translationProvider,
    translationDisplay: settings.translationDisplay,
    deeplApiKey: "",
    googleApiKey: "",
    showTranslate: settings.showTranslate,
    showSummary: settings.showSummary,
    showQna: settings.showQna,
    showMediaStrip: settings.showMediaStrip,
    emitJsonLd: settings.emitJsonLd,
    reviewsPerPage: String(settings.reviewsPerPage),
    designTheme: settings.designTheme,
  });

  const set = useCallback(
    <K extends keyof typeof form>(key: K) =>
      (value: (typeof form)[K]) =>
        setForm((prev) => ({ ...prev, [key]: value })),
    [],
  );

  const save = () => {
    saveFetcher.submit(
      {
        intent: "save",
        brandDisplayName: form.brandDisplayName,
        autoPublish: String(form.autoPublish),
        notifyEmail: form.notifyEmail,
        aiProvider: form.aiProvider,
        aiModel: form.aiModel,
        anthropicApiKey: form.anthropicApiKey,
        summaryAutoThreshold: form.summaryAutoThreshold,
        translationProvider: form.translationProvider,
        translationDisplay: form.translationDisplay,
        deeplApiKey: form.deeplApiKey,
        googleApiKey: form.googleApiKey,
        showTranslate: String(form.showTranslate),
        showSummary: String(form.showSummary),
        showQna: String(form.showQna),
        showMediaStrip: String(form.showMediaStrip),
        emitJsonLd: String(form.emitJsonLd),
        reviewsPerPage: form.reviewsPerPage,
        designTheme: form.designTheme,
      },
      { method: "post" },
    );
  };

  const saving = saveFetcher.state !== "idle";

  return (
    <Page
      title="Settings"
      primaryAction={{ content: "Save", onAction: save, loading: saving }}
    >
      <TitleBar title="Settings" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  General
                </Text>
                <BlockStack gap="150">
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="span" fontWeight="medium">
                      Storefront status
                    </Text>
                    {settings.isLive ? (
                      <Badge tone="success">Live</Badge>
                    ) : (
                      <Badge tone="attention">Not live</Badge>
                    )}
                  </InlineStack>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {settings.isLive
                        ? "Store visitors can see the review widget."
                        : "The review widget is hidden from store visitors until you go live."}
                    </Text>
                    <Button url="/app" variant="plain">
                      Preview & go live on the Dashboard
                    </Button>
                  </InlineStack>
                </BlockStack>
                <Divider />
                <FormLayout>
                  <TextField
                    label="Brand display name"
                    value={form.brandDisplayName}
                    onChange={set("brandDisplayName")}
                    autoComplete="off"
                    helpText="Shown on storefront brand replies, e.g. “Response from Cellexia”."
                  />
                  <Checkbox
                    label="Auto-publish new reviews"
                    checked={form.autoPublish}
                    onChange={set("autoPublish")}
                    helpText="When off, new reviews wait in Pending until you approve them (recommended)."
                  />
                  <TextField
                    label="Notification email"
                    type="email"
                    value={form.notifyEmail}
                    onChange={set("notifyEmail")}
                    autoComplete="email"
                    helpText="Stored for a future notification feature — the app does not send email notifications yet. New reviews appear under “Needs attention” on the Dashboard."
                  />
                </FormLayout>
              </BlockStack>
            </Card>

            {/* SPEC-1.6 §5 — the same seven-check report as the Dashboard card,
                reachable from Settings. The test itself lives in ONE place (the
                Dashboard), so there is never a second, disagreeing report. */}
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Storefront connection
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Seven checks prove that your storefront and this app can talk to each
                  other: the app proxy, the preview link, the theme app embed, your review
                  data, the product metafields that power the stars under your product
                  titles, database persistence and the live state. Run it after installing,
                  after changing your theme and whenever the widget looks wrong.
                </Text>
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Button url="/app?health=run">Test storefront connection</Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Opens the report on the Dashboard and runs the checks again.
                  </Text>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  AI summary
                </Text>
                <FormLayout>
                  <Select
                    label="AI provider"
                    options={[
                      { label: "Anthropic (Claude)", value: "anthropic" },
                      { label: "Off", value: "off" },
                    ]}
                    value={form.aiProvider}
                    onChange={set("aiProvider")}
                    helpText="Generates the “Customers say” summary and topic chips on your storefront."
                  />
                  <TextField
                    label="Anthropic (Claude) API key"
                    type="password"
                    value={form.anthropicApiKey}
                    onChange={set("anthropicApiKey")}
                    autoComplete="off"
                    placeholder={
                      settings.hasAnthropicKey
                        ? `•••••••• (saved key ends in ${settings.anthropicKeyHint})`
                        : "sk-ant-…"
                    }
                    helpText={
                      settings.hasAnthropicKey
                        ? `A key ending in ····${settings.anthropicKeyHint} is saved. To change it, paste the new key here and press Save — the old key is replaced. Leaving the field blank keeps the saved key.`
                        : "Paste your key and press Save. Get a key at console.anthropic.com."
                    }
                  />
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Button
                      loading={keyFetcher.state !== "idle" &&
                        keyFetcher.formData?.get("intent") === "test-anthropic-key"}
                      onClick={() =>
                        keyFetcher.submit(
                          {
                            intent: "test-anthropic-key",
                            anthropicApiKey: form.anthropicApiKey,
                            aiModel: form.aiModel,
                          },
                          { method: "post" },
                        )
                      }
                    >
                      Test key
                    </Button>
                    {settings.hasAnthropicKey ? (
                      <Button
                        tone="critical"
                        variant="secondary"
                        loading={keyFetcher.state !== "idle" &&
                          keyFetcher.formData?.get("intent") === "remove-anthropic-key"}
                        onClick={() =>
                          keyFetcher.submit(
                            { intent: "remove-anthropic-key" },
                            { method: "post" },
                          )
                        }
                      >
                        Remove saved key
                      </Button>
                    ) : null}
                    <Text as="span" variant="bodySm" tone="subdued">
                      Test checks the key in the field (or the saved one if blank) against the
                      Anthropic API — nothing is billed.
                    </Text>
                  </InlineStack>
                  <Select
                    label="Model"
                    options={[
                      { label: "Claude Sonnet 5 (recommended)", value: "claude-sonnet-5" },
                      { label: "Claude Haiku 4.5 (faster, lower cost)", value: "claude-haiku-4-5" },
                    ]}
                    value={form.aiModel}
                    onChange={set("aiModel")}
                  />
                  <TextField
                    label="Auto-regenerate threshold"
                    type="number"
                    value={form.summaryAutoThreshold}
                    onChange={set("summaryAutoThreshold")}
                    autoComplete="off"
                    min={1}
                    max={100}
                    helpText="Regenerate a product's summary after this many newly published reviews."
                  />
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      loading={regenFetcher.state !== "idle"}
                      onClick={() =>
                        regenFetcher.submit({ intent: "regenerate-all" }, { method: "post" })
                      }
                    >
                      Regenerate all now
                    </Button>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Regenerates the AI summary for every product with published reviews.
                    </Text>
                  </InlineStack>
                  <Checkbox
                    label="Review Q&A (“Looking for specific info?”)"
                    checked={form.showQna}
                    onChange={set("showQna")}
                    helpText="Shoppers type a question under the AI summary and get an answer grounded in your reviews, with supporting quotes — answers speak as your brand. Uses the Claude API key above; each distinct question per product is answered once and then cached (capped at 200 fresh answers per day). Off by default."
                  />
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Translation
                </Text>
                <FormLayout>
                  <Select
                    label="Translation provider"
                    options={[
                      { label: "Anthropic (Claude)", value: "anthropic" },
                      { label: "DeepL", value: "deepl" },
                      { label: "Google Cloud Translation", value: "google" },
                      { label: "Off", value: "off" },
                    ]}
                    value={form.translationProvider}
                    onChange={set("translationProvider")}
                    helpText="Translates customer reviews on demand. Anthropic reuses the API key above."
                  />
                  <TextField
                    label="DeepL API key"
                    type="password"
                    value={form.deeplApiKey}
                    onChange={set("deeplApiKey")}
                    autoComplete="off"
                    placeholder={settings.hasDeeplKey ? "•••••••• (key saved)" : ""}
                    helpText="Leave blank to keep the saved key."
                  />
                  <TextField
                    label="Google API key"
                    type="password"
                    value={form.googleApiKey}
                    onChange={set("googleApiKey")}
                    autoComplete="off"
                    placeholder={settings.hasGoogleKey ? "•••••••• (key saved)" : ""}
                    helpText="Leave blank to keep the saved key."
                  />
                  <Checkbox
                    label="Show “Translate” buttons on the storefront"
                    checked={form.showTranslate}
                    onChange={set("showTranslate")}
                  />
                  {/* v1.8 (SPEC-1.8 §4): translation display mode. */}
                  <ChoiceList
                    title="Reviews written in other languages"
                    choices={[
                      {
                        value: "original",
                        label:
                          "Show in the original language, with a Translate button (default)",
                      },
                      {
                        value: "translated",
                        label:
                          "Automatically translate into the shopper's language, with a “See original” option",
                        helpText:
                          "Uses the translation provider above. When a translation isn't available, the original review is shown with a Translate button.",
                      },
                    ]}
                    selected={[form.translationDisplay]}
                    onChange={(selected) =>
                      set("translationDisplay")(selected[0] ?? "original")
                    }
                  />
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Design
                </Text>
                <ChoiceList
                  title="Design version"
                  titleHidden
                  choices={[
                    {
                      value: "amazon",
                      label:
                        "Amazon like — the battle-tested review layout shoppers know from Amazon",
                      helpText: <DesignPreviewSwatches theme="amazon" />,
                    },
                    {
                      value: "cellexia",
                      label:
                        "Cellexia — same trusted layout, styled to match cellexialabs.com (ink & periwinkle, Gobold headings, pill buttons)",
                      helpText: <DesignPreviewSwatches theme="cellexia" />,
                    },
                    {
                      value: "luxe",
                      label: "Luxe — premium skincare",
                      helpText: (
                        <>
                          The same trusted layout with the warmth of a premium skincare brand:
                          porcelain neutrals, champagne-gold stars, refined serif headings, soft
                          edges.
                          <DesignPreviewSwatches theme="luxe" />
                        </>
                      ),
                    },
                  ]}
                  selected={[form.designTheme]}
                  onChange={(selected) => set("designTheme")(selected[0] ?? "amazon")}
                />
                <Text as="p" variant="bodySm" tone="subdued">
                  Applies storefront-wide. Changes take effect within a minute (metafield sync).
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Display
                </Text>
                <FormLayout>
                  <TextField
                    label="Reviews per page"
                    type="number"
                    value={form.reviewsPerPage}
                    onChange={set("reviewsPerPage")}
                    autoComplete="off"
                    min={1}
                    max={50}
                    helpText="Default page size for the storefront widget (1–50)."
                  />
                  <Checkbox
                    label="Show the “Reviews with images” media strip"
                    checked={form.showMediaStrip}
                    onChange={set("showMediaStrip")}
                  />
                  <Checkbox
                    label="Show the AI “Customers say” summary section"
                    checked={form.showSummary}
                    onChange={set("showSummary")}
                  />
                  <Checkbox
                    label="Emit JSON-LD structured data (Google star rich snippets)"
                    checked={form.emitJsonLd}
                    onChange={set("emitJsonLd")}
                  />
                </FormLayout>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Data
                </Text>
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Button url="/app/import-export">Export reviews CSV</Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Download every review as a CSV from the Import / Export page.
                  </Text>
                </InlineStack>
                <InlineStack gap="200" blockAlign="center" wrap>
                  <Button
                    loading={tokenFetcher.state !== "idle"}
                    onClick={() =>
                      tokenFetcher.submit({ intent: "regen-preview-token" }, { method: "post" })
                    }
                  >
                    Regenerate preview link
                  </Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Creates a new storefront preview URL — previously shared preview links stop
                    working.
                  </Text>
                </InlineStack>
                <Divider />
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm" tone="critical">
                    Danger zone
                  </Text>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Button tone="critical" onClick={() => setDeleteOpen(true)}>
                      Delete all app data
                    </Button>
                    <Text as="span" variant="bodySm" tone="subdued">
                      Permanently removes every review, vote, summary, translation and this
                      settings record for the store.
                    </Text>
                  </InlineStack>
                </BlockStack>
              </BlockStack>
            </Card>

            <Box paddingBlockEnd="400">
              <InlineStack align="end">
                <Button variant="primary" onClick={save} loading={saving}>
                  Save
                </Button>
              </InlineStack>
            </Box>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <ConfirmationModal
        open={deleteOpen}
        title="Delete all app data?"
        message="This permanently deletes every review, media reference, vote, AI summary, cached translation and the app settings for this store. Product metafields are not cleared automatically. This cannot be undone."
        confirmLabel="Delete all data"
        loading={deleteFetcher.state !== "idle"}
        onConfirm={() => deleteFetcher.submit({ intent: "delete-all-data" }, { method: "post" })}
        onCancel={() => setDeleteOpen(false)}
      />
    </Page>
  );
}
