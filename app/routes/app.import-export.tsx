import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  DropZone,
  InlineStack,
  Layout,
  Page,
  ProgressBar,
  Select,
  Spinner,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
// @ts-ignore -- papaparse ships without bundled type declarations
import Papa from "papaparse";

import { authenticate } from "~/shopify.server";
import prisma from "~/db.server";
import {
  DRY_RUN_CHUNK_SIZE,
  ERROR_TABLE_LIMIT,
  EXPORT_COLUMNS,
  IMPORT_CHUNK_SIZE,
  MAX_IMPORT_ROWS,
  buildImportTemplateCsv,
  buildReviewExportCsv,
  getImportPresets,
  importRows,
  lookupResolved,
  resolveProducts,
  sanitizeProductIdList,
  toDateFormat,
  toPresetKey,
  validateRows,
} from "~/services/import.server";
import type { ResolvedProduct, RowError } from "~/services/import.server";
import { syncProductData } from "~/components/admin/moderation.server";
import { useResultToast } from "~/components/admin/useResultToast";
import { formatDate, pluralize } from "~/components/admin/labels";

// ─── Loader ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  let totalReviews = 0;
  let publishedReviews = 0;
  try {
    [totalReviews, publishedReviews] = await Promise.all([
      prisma.review.count({ where: { shop } }),
      prisma.review.count({ where: { shop, status: "PUBLISHED" } }),
    ]);
  } catch (error) {
    console.error("[cellexia] import-export loader counts failed", error);
  }
  return json({
    totalReviews,
    publishedReviews,
    template: buildImportTemplateCsv(),
    presets: getImportPresets(),
    exportColumns: EXPORT_COLUMNS,
    limits: {
      maxRows: MAX_IMPORT_ROWS,
      importChunk: IMPORT_CHUNK_SIZE,
      dryRunChunk: DRY_RUN_CHUNK_SIZE,
      errorTableLimit: ERROR_TABLE_LIMIT,
    },
  });
};

// ─── Action ──────────────────────────────────────────────────────────────────

interface PreviewRowDTO {
  row: number;
  product: string;
  rating: number;
  title: string | null;
  author: string;
  date: string | null;
  verified: boolean;
  excerpt: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let form: FormData;
  try {
    form = await request.formData();
  } catch (error) {
    console.error("Import/export request body unreadable", error);
    return json({ ok: false, message: "The request could not be read. Please try again." }, { status: 400 });
  }
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "export") {
      const { csv, count } = await buildReviewExportCsv(shop);
      const date = new Date().toISOString().slice(0, 10);
      return json({
        ok: true,
        kind: "export",
        csv,
        filename: `cellexia-reviews-${date}.csv`,
        message: `Exported ${pluralize(count, "review")}`,
      });
    }

    if (intent === "dry-run") {
      const rows = parsePayloadRows(form, DRY_RUN_CHUNK_SIZE);
      if (!rows) {
        return json(
          { ok: false, message: "The uploaded rows could not be read — please re-upload the file." },
          { status: 400 },
        );
      }
      const { valid, errors } = validateRows(rows, {
        key: toPresetKey(form.get("preset")),
        dateFormat: toDateFormat(form.get("dateFormat")),
      });

      // Resolve product references so unresolved products surface in the dry
      // run, not halfway through the import.
      let resolved: Map<string, ResolvedProduct> = new Map();
      if (valid.length) {
        try {
          resolved = await resolveProducts(
            admin,
            valid.map((row) => ({
              productId: row.productId ?? undefined,
              handle: row.productHandle ?? undefined,
            })),
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Shopify product lookup failed — please try again";
          return json({ ok: false, message }, { status: 502 });
        }
      }
      const validRowNumbers: number[] = [];
      const preview: PreviewRowDTO[] = [];
      for (const row of valid) {
        const product = lookupResolved(resolved, row);
        if (!product) {
          const ref = row.productId ?? row.productHandle ?? "?";
          errors.push({
            row: row.row,
            field: row.productId ? "product_id" : "product_handle",
            code: "product_not_found",
            message: `No product in this store matches "${String(ref).slice(0, 60)}"`,
          });
          continue;
        }
        validRowNumbers.push(row.row);
        if (preview.length < 5) {
          preview.push({
            row: row.row,
            product: product.title || product.handle || product.id,
            rating: row.rating,
            title: row.title,
            author: row.authorName,
            date: row.createdAt,
            verified: row.verified,
            excerpt: row.body.length > 60 ? `${row.body.slice(0, 60)}…` : row.body,
          });
        }
      }
      errors.sort((a, b) => a.row - b.row);
      return json({ ok: true, kind: "dry-run", validRowNumbers, errors, preview });
    }

    if (intent === "import-chunk") {
      const rows = parsePayloadRows(form, IMPORT_CHUNK_SIZE);
      if (!rows) {
        return json(
          { ok: false, message: "The import rows could not be read — please re-run the validation." },
          { status: 400 },
        );
      }
      const { valid, errors } = validateRows(rows, {
        key: toPresetKey(form.get("preset")),
        dateFormat: toDateFormat(form.get("dateFormat")),
      });
      const defaultStatus = form.get("defaultStatus") === "PENDING" ? "PENDING" : "PUBLISHED";
      const result = await importRows(shop, admin, valid, {
        defaultStatus,
        source: "csv-import",
      });
      return json({
        ok: true,
        kind: "import-chunk",
        created: result.created,
        skippedDuplicates: result.skippedDuplicates,
        errors: [...errors, ...result.errors],
        productIds: result.productIds,
      });
    }

    if (intent === "finalize-import") {
      const ids = sanitizeProductIdList(form.get("productIds"));
      let synced = 0;
      let failed = 0;
      for (const productId of ids) {
        try {
          await syncProductData(shop, productId, admin);
          synced += 1;
        } catch (error) {
          failed += 1;
          console.error(`Metafield sync failed for product ${productId}`, error);
        }
      }
      const message =
        ids.length === 0
          ? "Import finished"
          : failed
            ? `Import finished — ratings updated for ${synced} of ${pluralize(ids.length, "product")} (sync failed for ${failed}; check that the products exist)`
            : `Import finished — product ratings updated for ${pluralize(synced, "product")}`;
      return json({ ok: true, kind: "finalize", message, synced, failed });
    }

    return json({ ok: false, message: "Unknown action" }, { status: 400 });
  } catch (error) {
    console.error("Import/export action failed", error);
    return json(
      { ok: false, message: "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
};

function parsePayloadRows(form: FormData, cap: number): unknown[] | null {
  try {
    const parsed = JSON.parse(String(form.get("payload") ?? "[]"));
    return Array.isArray(parsed) ? parsed.slice(0, cap) : null;
  } catch {
    return null;
  }
}

// ─── Client types & helpers ──────────────────────────────────────────────────

type RawRecord = Record<string, unknown>;

type Phase = "idle" | "validating" | "validated" | "importing" | "finalizing" | "done";

interface FileState {
  fileName: string;
  headers: string[];
  rows: RawRecord[];
  /** True when the file exceeded the row cap and was cut off. */
  truncated: boolean;
  originalRowCount: number;
  /** CSV-level parse issues reported by papaparse (first few, informational). */
  parseWarnings: string[];
}

interface ValidationResult {
  totalRows: number;
  validRowNumbers: number[];
  errors: RowError[];
  preview: PreviewRowDTO[];
}

interface ImportSummary {
  created: number;
  skippedDuplicates: number;
  errors: RowError[];
  synced: number;
  syncFailed: number;
  /** Set when a chunk or the finalize step failed part-way. */
  abortMessage: string | null;
}

interface PipelineJob {
  kind: "validate" | "import";
  chunks: RawRecord[][];
  index: number;
  awaiting: boolean;
  lastData: unknown;
  presetKey: string;
  dateFormat: string;
  defaultStatus: string;
  totalRows: number;
  processedRows: number;
  // accumulators
  validRowNumbers: number[];
  errors: RowError[];
  preview: PreviewRowDTO[];
  created: number;
  skipped: number;
  productIds: Set<string>;
  finalizing: boolean;
  abortMessage: string | null;
}

type PipelineData =
  | { ok: true; kind: "dry-run"; validRowNumbers: number[]; errors: RowError[]; preview: PreviewRowDTO[] }
  | {
      ok: true;
      kind: "import-chunk";
      created: number;
      skippedDuplicates: number;
      errors: RowError[];
      productIds: string[];
    }
  | { ok: true; kind: "finalize"; message: string; synced: number; failed: number }
  | { ok: false; message?: string };

interface CsvParseError {
  message: string;
  row?: number;
}
interface CsvParseResults {
  data: Record<string, string>[];
  errors: CsvParseError[];
  meta?: { fields?: string[] };
}

/** Must stay in sync with the papaparse transformHeader used below. */
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function downloadBlob(content: string, filename: string) {
  try {
    const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    console.error("[cellexia] download failed", error);
  }
}

function errorReportCsv(errors: RowError[]): string {
  return Papa.unparse({
    fields: ["row", "field", "code", "message"],
    data: errors.map((e) => [e.row, e.field, e.code, e.message]),
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ImportExport() {
  const { totalReviews, template, presets, exportColumns, limits } =
    useLoaderData<typeof loader>();

  const exportFetcher = useFetcher<typeof action>();
  const pipelineFetcher = useFetcher<typeof action>();

  const [preset, setPreset] = useState("generic");
  const [detectedLabel, setDetectedLabel] = useState<string | null>(null);
  const [dateFormat, setDateFormat] = useState("auto");
  const [defaultStatus, setDefaultStatus] = useState("PUBLISHED");
  const [fileState, setFileState] = useState<FileState | null>(null);
  const [parsing, setParsing] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const jobRef = useRef<PipelineJob | null>(null);

  useResultToast(exportFetcher);
  useResultToast(pipelineFetcher);

  const busy = parsing || phase === "validating" || phase === "importing" || phase === "finalizing";

  // Trigger the browser download when the export CSV arrives.
  const handledExport = useRef<unknown>(null);
  useEffect(() => {
    const data = exportFetcher.data as
      | { ok?: boolean; csv?: string; filename?: string }
      | undefined;
    if (exportFetcher.state !== "idle" || !data?.csv || data === handledExport.current) return;
    handledExport.current = data;
    downloadBlob(data.csv, data.filename || "cellexia-reviews.csv");
  }, [exportFetcher.state, exportFetcher.data]);

  // Warn before leaving mid-import (a closed tab would leave product
  // aggregates unsynced until the finalize step re-runs).
  useEffect(() => {
    if (phase !== "importing" && phase !== "finalizing") return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [phase]);

  const startValidation = useCallback(
    (file: FileState, presetKey: string, dateFmt: string) => {
      if (!file.rows.length) {
        setValidation({ totalRows: 0, validRowNumbers: [], errors: [], preview: [] });
        setPhase("validated");
        return;
      }
      jobRef.current = {
        kind: "validate",
        chunks: chunkArray(file.rows, limits.dryRunChunk),
        index: 0,
        awaiting: false,
        lastData: pipelineFetcher.data,
        presetKey,
        dateFormat: dateFmt,
        defaultStatus,
        totalRows: file.rows.length,
        processedRows: 0,
        validRowNumbers: [],
        errors: [],
        preview: [],
        created: 0,
        skipped: 0,
        productIds: new Set(),
        finalizing: false,
        abortMessage: null,
      };
      setValidation(null);
      setSummary(null);
      setRunError(null);
      setProgress({ done: 0, total: file.rows.length });
      setPhase("validating");
    },
    [defaultStatus, limits.dryRunChunk, pipelineFetcher.data],
  );

  const startImport = useCallback(() => {
    if (!fileState || !validation || !validation.validRowNumbers.length) return;
    const validSet = new Set(validation.validRowNumbers);
    const rowsToImport = fileState.rows.filter(
      (row) => typeof row._row === "number" && validSet.has(row._row),
    );
    if (!rowsToImport.length) return;
    jobRef.current = {
      kind: "import",
      chunks: chunkArray(rowsToImport, limits.importChunk),
      index: 0,
      awaiting: false,
      lastData: pipelineFetcher.data,
      presetKey: preset,
      dateFormat,
      defaultStatus,
      totalRows: rowsToImport.length,
      processedRows: 0,
      validRowNumbers: [],
      errors: [],
      preview: [],
      created: 0,
      skipped: 0,
      productIds: new Set(),
      finalizing: false,
      abortMessage: null,
    };
    setSummary(null);
    setRunError(null);
    setProgress({ done: 0, total: rowsToImport.length });
    setPhase("importing");
  }, [dateFormat, defaultStatus, fileState, limits.importChunk, pipelineFetcher.data, preset, validation]);

  // Sequential chunk driver: one fetcher submission at a time; each settled
  // response is folded into the job before the next chunk goes out.
  useEffect(() => {
    const job = jobRef.current;
    if (!job || pipelineFetcher.state !== "idle") return;
    const data = pipelineFetcher.data as unknown as PipelineData | undefined;

    if (job.awaiting) {
      if (data == null || data === job.lastData) return;
      job.lastData = data;
      job.awaiting = false;

      if (job.kind === "validate") {
        if (!data.ok || data.kind !== "dry-run") {
          jobRef.current = null;
          setPhase("idle");
          setRunError(
            (!data.ok && data.message) || "Validation failed — please try the file again.",
          );
          return;
        }
        job.validRowNumbers.push(...data.validRowNumbers);
        job.errors.push(...data.errors);
        if (job.preview.length < 5) {
          job.preview.push(...data.preview.slice(0, 5 - job.preview.length));
        }
        job.processedRows += job.chunks[job.index]?.length ?? 0;
        job.index += 1;
        setProgress({ done: job.processedRows, total: job.totalRows });
      } else if (job.finalizing) {
        // Any response (even a failure) ends the run — report honestly.
        const finalize = data.ok && data.kind === "finalize" ? data : null;
        jobRef.current = null;
        setSummary({
          created: job.created,
          skippedDuplicates: job.skipped,
          errors: job.errors,
          synced: finalize?.synced ?? 0,
          syncFailed: finalize ? finalize.failed : job.productIds.size,
          abortMessage:
            job.abortMessage ??
            (finalize
              ? null
              : (!data.ok && data.message) ||
                "Product ratings could not be updated — re-run the import or edit a review to refresh them."),
        });
        setPhase("done");
        setFileState(null);
        setValidation(null);
        setDetectedLabel(null);
        return;
      } else if (!data.ok || data.kind !== "import-chunk") {
        // A chunk failed part-way: stop importing but still finalize what was
        // created so the affected products' aggregates stay correct.
        job.abortMessage =
          (!data.ok && data.message) || "The import stopped early — some rows were not imported.";
        job.index = job.chunks.length;
      } else {
        job.created += data.created;
        job.skipped += data.skippedDuplicates;
        job.errors.push(...data.errors);
        for (const id of data.productIds) job.productIds.add(id);
        job.processedRows += job.chunks[job.index]?.length ?? 0;
        job.index += 1;
        setProgress({ done: job.processedRows, total: job.totalRows });
      }
    }

    if (job.awaiting) return;

    if (job.index < job.chunks.length) {
      const chunk = job.chunks[job.index];
      job.awaiting = true;
      pipelineFetcher.submit(
        {
          intent: job.kind === "validate" ? "dry-run" : "import-chunk",
          preset: job.presetKey,
          dateFormat: job.dateFormat,
          defaultStatus: job.defaultStatus,
          payload: JSON.stringify(chunk),
        },
        { method: "post" },
      );
      return;
    }

    if (job.kind === "validate") {
      jobRef.current = null;
      setValidation({
        totalRows: job.totalRows,
        validRowNumbers: job.validRowNumbers,
        errors: job.errors,
        preview: job.preview,
      });
      setPhase("validated");
      return;
    }

    if (!job.finalizing) {
      job.finalizing = true;
      job.awaiting = true;
      setPhase("finalizing");
      pipelineFetcher.submit(
        { intent: "finalize-import", productIds: JSON.stringify([...job.productIds]) },
        { method: "post" },
      );
    }
  }, [pipelineFetcher, pipelineFetcher.state, pipelineFetcher.data, phase]);

  const handleDrop = useCallback(
    (_dropFiles: File[], acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file || busy) return;
      setParsing(true);
      setFileState(null);
      setValidation(null);
      setSummary(null);
      setRunError(null);
      setDetectedLabel(null);
      setPhase("idle");
      Papa.parse(file, {
        header: true,
        skipEmptyLines: "greedy",
        transformHeader: normalizeHeader,
        complete: (results: CsvParseResults) => {
          try {
            const originalRowCount = results.data.length;
            const rows: RawRecord[] = results.data
              .slice(0, limits.maxRows)
              .map((raw, index) => ({ ...raw, _row: index + 2 }));
            const headers = (results.meta?.fields ?? []).map(normalizeHeader);
            const parseWarnings = results.errors
              .slice(0, 5)
              .map(
                (err) =>
                  `CSV parse issue${err.row != null ? ` near row ${err.row + 2}` : ""}: ${err.message}`,
              );
            const next: FileState = {
              fileName: file.name,
              headers,
              rows,
              truncated: originalRowCount > limits.maxRows,
              originalRowCount,
              parseWarnings,
            };

            // Preset auto-detection from the header row.
            const headerSet = new Set(headers);
            let detectedKey: string | null = null;
            let bestScore = 0;
            for (const option of presets) {
              const score = option.detect.filter((h) => headerSet.has(h)).length;
              if (score >= 2 && score > bestScore) {
                bestScore = score;
                detectedKey = option.key;
              }
            }
            let activePreset = preset;
            if (detectedKey && detectedKey !== preset) {
              activePreset = detectedKey;
              setPreset(detectedKey);
            }
            setDetectedLabel(
              detectedKey
                ? presets.find((p) => p.key === detectedKey)?.label ?? null
                : null,
            );

            setFileState(next);
            setParsing(false);
            if (results.errors.length && rows.length === 0) {
              setRunError("The file could not be read as CSV.");
              return;
            }
            startValidation(next, activePreset, dateFormat);
          } catch (error) {
            console.error("[cellexia] CSV parse handling failed", error);
            setParsing(false);
            setRunError("The file could not be processed. Please check that it is a valid CSV.");
          }
        },
        error: () => {
          setParsing(false);
          setRunError("The file could not be read as CSV.");
        },
      });
    },
    [busy, dateFormat, limits.maxRows, preset, presets, startValidation],
  );

  const handlePresetChange = useCallback(
    (value: string) => {
      setPreset(value);
      setDetectedLabel(null);
      if (fileState && !busy) startValidation(fileState, value, dateFormat);
    },
    [busy, dateFormat, fileState, startValidation],
  );

  const handleDateFormatChange = useCallback(
    (value: string) => {
      setDateFormat(value);
      if (fileState && !busy) startValidation(fileState, preset, value);
    },
    [busy, fileState, preset, startValidation],
  );

  const progressPercent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  const readyCount = validation?.validRowNumbers.length ?? 0;
  const validationErrors = validation?.errors ?? [];

  const errorTableRows = (errors: RowError[]) =>
    errors.slice(0, limits.errorTableLimit).map((e) => [String(e.row), e.field, e.message]);

  return (
    <Page title="Import / Export">
      <TitleBar title="Import / Export" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Export reviews
                </Text>
                <Text as="p" tone="subdued">
                  Downloads all {pluralize(totalReviews, "review")} for this store as a CSV
                  file. The column set matches the Generic import template, so an export can
                  be re-imported as-is.
                </Text>
                <InlineStack gap="200">
                  <Button
                    variant="primary"
                    loading={exportFetcher.state !== "idle"}
                    disabled={totalReviews === 0}
                    onClick={() => exportFetcher.submit({ intent: "export" }, { method: "post" })}
                  >
                    Export all reviews (CSV)
                  </Button>
                </InlineStack>
                <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                  <BlockStack gap="100">
                    <Text as="span" variant="bodySm" fontWeight="semibold">
                      Columns
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {exportColumns.join(", ")}
                    </Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      skin_concerns, results_seen and image_urls are pipe-separated (|); dates
                      are ISO 8601; verified is true/false. is_synthetic, source and
                      synthetic_batch_id show where each review came from and are ignored on
                      import.
                    </Text>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  Import reviews
                </Text>
                <Text as="p" tone="subdued">
                  Upload a CSV exported from Judge.me, Loox, Yotpo or the Generic template.
                  Every row is validated in a dry run before anything is written; duplicates
                  of existing reviews are skipped automatically. Large files import in chunks
                  of {limits.importChunk} rows with a progress bar.
                </Text>
                <InlineStack gap="200" blockAlign="center">
                  <Button
                    onClick={() => downloadBlob(template, "cellexia-import-template.csv")}
                  >
                    Download CSV template
                  </Button>
                  <Text as="span" variant="bodySm" tone="subdued">
                    Header row plus two example rows in the Generic format.
                  </Text>
                </InlineStack>

                <Select
                  label="Source format"
                  options={presets.map((p) => ({ label: p.label, value: p.key }))}
                  value={preset}
                  onChange={handlePresetChange}
                  disabled={busy}
                  helpText={
                    detectedLabel
                      ? `Detected: ${detectedLabel}`
                      : "Pick the platform the CSV came from so the columns map correctly."
                  }
                />
                <InlineStack gap="400" wrap>
                  <Box minWidth="240px">
                    <Select
                      label="Date format"
                      options={[
                        { label: "Auto (ISO 8601 / YYYY-MM-DD)", value: "auto" },
                        { label: "DD/MM/YYYY", value: "dmy" },
                        { label: "MM/DD/YYYY", value: "mdy" },
                      ]}
                      value={dateFormat}
                      onChange={handleDateFormatChange}
                      disabled={busy}
                      helpText="Ambiguous dates like 03/04/2026 follow this choice (Auto reads them as MM/DD/YYYY)."
                    />
                  </Box>
                  <Box minWidth="240px">
                    <Select
                      label="Import as"
                      options={[
                        { label: "Published", value: "PUBLISHED" },
                        { label: "Pending review", value: "PENDING" },
                      ]}
                      value={defaultStatus}
                      onChange={setDefaultStatus}
                      disabled={busy}
                      helpText="Rows with their own status column keep it; all other rows get this status."
                    />
                  </Box>
                </InlineStack>

                <DropZone
                  accept=".csv,text/csv"
                  allowMultiple={false}
                  onDrop={handleDrop}
                  disabled={busy}
                  errorOverlayText="The file must be a .csv"
                >
                  {fileState ? (
                    <Box padding="400">
                      <BlockStack gap="100" inlineAlign="center">
                        <Text as="span" fontWeight="semibold">
                          {fileState.fileName}
                        </Text>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {pluralize(fileState.rows.length, "row")} — drop another file to
                          replace it
                        </Text>
                      </BlockStack>
                    </Box>
                  ) : (
                    <DropZone.FileUpload
                      actionTitle="Add CSV file"
                      actionHint="or drop a file to upload"
                    />
                  )}
                </DropZone>

                {parsing ? (
                  <InlineStack gap="200" blockAlign="center">
                    <Spinner size="small" accessibilityLabel="Parsing CSV" />
                    <Text as="span" tone="subdued">
                      Parsing file…
                    </Text>
                  </InlineStack>
                ) : null}

                {runError ? (
                  <Banner
                    tone="critical"
                    title={runError}
                    action={
                      fileState && phase === "idle"
                        ? {
                            content: "Retry validation",
                            onAction: () => startValidation(fileState, preset, dateFormat),
                          }
                        : undefined
                    }
                  />
                ) : null}

                {phase === "validating" ? (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">
                      Validating {progress.done} of {pluralize(progress.total, "row")}…
                    </Text>
                    <ProgressBar progress={progressPercent} size="small" />
                  </BlockStack>
                ) : null}

                {phase === "validated" && validation && fileState ? (
                  <BlockStack gap="300">
                    <Banner
                      tone={
                        readyCount === 0
                          ? "critical"
                          : validationErrors.length
                            ? "warning"
                            : "success"
                      }
                      title={`Dry run: ${pluralize(validation.totalRows, "row")} checked — ${readyCount} ready to import, ${validationErrors.length} ${validationErrors.length === 1 ? "error" : "errors"}`}
                    >
                      <BlockStack gap="100">
                        <Text as="p">
                          Duplicates of existing reviews are detected during the import and
                          skipped — they are not counted here.
                        </Text>
                        {fileState.truncated ? (
                          <Text as="p">
                            The file has {fileState.originalRowCount} rows; only the first{" "}
                            {limits.maxRows} are processed per import.
                          </Text>
                        ) : null}
                        {fileState.parseWarnings.map((warning, index) => (
                          <Text as="p" key={index}>
                            {warning}
                          </Text>
                        ))}
                      </BlockStack>
                    </Banner>

                    {validationErrors.length ? (
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          {validationErrors.length > limits.errorTableLimit
                            ? `First ${limits.errorTableLimit} of ${validationErrors.length} errors`
                            : `Errors (${validationErrors.length})`}
                        </Text>
                        <DataTable
                          columnContentTypes={["numeric", "text", "text"]}
                          headings={["Row", "Column", "Problem"]}
                          rows={errorTableRows(validationErrors)}
                        />
                        <InlineStack gap="200" blockAlign="center">
                          <Button
                            onClick={() =>
                              downloadBlob(
                                errorReportCsv(validationErrors),
                                "cellexia-import-errors.csv",
                              )
                            }
                          >
                            Download full error report
                          </Button>
                          <Text as="span" variant="bodySm" tone="subdued">
                            Rows with errors are skipped — fix them in the file and re-upload.
                          </Text>
                        </InlineStack>
                      </BlockStack>
                    ) : null}

                    {validation.preview.length ? (
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          Preview (first {validation.preview.length}{" "}
                          {validation.preview.length === 1 ? "row" : "rows"})
                        </Text>
                        <DataTable
                          columnContentTypes={[
                            "text",
                            "numeric",
                            "text",
                            "text",
                            "text",
                            "text",
                            "text",
                          ]}
                          headings={[
                            "Product",
                            "Rating",
                            "Title",
                            "Author",
                            "Date",
                            "Verified",
                            "Body",
                          ]}
                          rows={validation.preview.map((row) => [
                            row.product,
                            row.rating,
                            row.title ?? "—",
                            row.author,
                            row.date ? formatDate(row.date) : "—",
                            row.verified ? "Yes" : "No",
                            row.excerpt,
                          ])}
                        />
                      </BlockStack>
                    ) : null}

                    {readyCount > 0 ? (
                      <InlineStack gap="200" blockAlign="center">
                        <Button variant="primary" onClick={startImport}>
                          Import {pluralize(readyCount, "review")}
                        </Button>
                        <Text as="span" variant="bodySm" tone="subdued">
                          Product ratings, metafields and star snippets update automatically
                          after the import.
                        </Text>
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                ) : null}

                {phase === "importing" || phase === "finalizing" ? (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued">
                      {phase === "importing"
                        ? `Imported ${progress.done} of ${pluralize(progress.total, "row")}…`
                        : "Updating product ratings…"}
                    </Text>
                    <ProgressBar
                      progress={phase === "finalizing" ? 100 : progressPercent}
                      size="small"
                    />
                    <Text as="span" variant="bodySm" tone="subdued">
                      Keep this page open until the import finishes.
                    </Text>
                  </BlockStack>
                ) : null}

                {phase === "done" && summary ? (
                  <BlockStack gap="300">
                    <Banner
                      tone={
                        summary.abortMessage || summary.errors.length || summary.syncFailed
                          ? "warning"
                          : "success"
                      }
                      title={`Import complete: ${pluralize(summary.created, "review")} created, ${summary.skippedDuplicates} duplicate${summary.skippedDuplicates === 1 ? "" : "s"} skipped, ${summary.errors.length} ${summary.errors.length === 1 ? "row" : "rows"} failed`}
                    >
                      <BlockStack gap="100">
                        {summary.abortMessage ? <Text as="p">{summary.abortMessage}</Text> : null}
                        {summary.syncFailed ? (
                          <Text as="p">
                            Ratings could not be refreshed for{" "}
                            {pluralize(summary.syncFailed, "product")} — approve or edit any
                            review of those products to retry the sync.
                          </Text>
                        ) : summary.synced > 0 ? (
                          <Text as="p">
                            Product ratings updated for {pluralize(summary.synced, "product")}.
                          </Text>
                        ) : (
                          <Text as="p">No product ratings needed updating.</Text>
                        )}
                      </BlockStack>
                    </Banner>
                    {summary.errors.length ? (
                      <BlockStack gap="200">
                        <Text as="h3" variant="headingSm">
                          {summary.errors.length > limits.errorTableLimit
                            ? `First ${limits.errorTableLimit} of ${summary.errors.length} import errors`
                            : `Import errors (${summary.errors.length})`}
                        </Text>
                        <DataTable
                          columnContentTypes={["numeric", "text", "text"]}
                          headings={["Row", "Column", "Problem"]}
                          rows={errorTableRows(summary.errors)}
                        />
                        <Button
                          onClick={() =>
                            downloadBlob(
                              errorReportCsv(summary.errors),
                              "cellexia-import-errors.csv",
                            )
                          }
                        >
                          Download full error report
                        </Button>
                      </BlockStack>
                    ) : null}
                  </BlockStack>
                ) : null}

                <Banner tone="info" title="Media limitation">
                  <Text as="p">
                    Imported photo and video URLs are kept as external links — they are not
                    re-uploaded to Shopify Files. They display in the widget as long as the
                    source URLs stay online.
                  </Text>
                </Banner>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
