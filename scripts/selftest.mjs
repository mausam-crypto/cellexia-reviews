#!/usr/bin/env node
/**
 * selftest.mjs — proves, from the command line, that a store's app proxy really
 * reaches THIS app (SPEC-1.6 §5).
 *
 *   npm run selftest -- --shop=your-store.myshopify.com
 *
 * For every candidate subpath it performs a plain public GET of
 * `https://<shop>/apps/<subpath>/api/ping` — the one proxy route that is never
 * gated by the live state — and prints a PASS/FAIL table:
 *
 *   PASS  the response is HTTP 200 with JSON `{ "app": "cellexia-reviews", … }`,
 *         i.e. Shopify forwarded the request, the HMAC verified with
 *         SHOPIFY_API_SECRET and our route answered. That subpath works.
 *   FAIL  anything else — Shopify's own 404 page (no proxy on that subpath), a
 *         theme page, another app's JSON, a timeout, 401 (secret mismatch), …
 *
 * Exit code: 0 when at least one candidate reached the app, 1 when none did,
 * 2 on a usage error. No dependencies, Node 20+ (global fetch,
 * AbortSignal.timeout). Nothing is written anywhere; the probe is read-only and
 * carries no credentials or shopper data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * MIRROR of `PROXY_CANDIDATES` in app/services/proxyhealth.server.ts — a plain
 * .mjs script cannot import the TypeScript service. Keep the two lists in sync.
 */
const PROXY_CANDIDATES = ["cellexia-reviews", "cellexia", "reviews", "cellexia-review"];

/** Value of `app` in our ping payload — the proof that WE answered. */
const APP_ID = "cellexia-reviews";

const DEFAULT_TIMEOUT_MS = 6000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const MAX_DETAIL_LENGTH = 96;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = `Usage: npm run selftest -- --shop=<your-store>.myshopify.com [options]

Probes every app-proxy subpath candidate on the store's storefront and reports
which one reaches this app (GET /apps/<subpath>/api/ping).

Options:
  --shop=<domain>    Store domain to probe — the .myshopify.com domain or the
                     live custom domain. Required.
  --subpath=<a[,b]>  Extra subpath candidate(s), tried before the built-in list
                     (${PROXY_CANDIDATES.join(", ")}).
  --timeout=<sec>    Per-candidate timeout in seconds (default ${DEFAULT_TIMEOUT_MS / 1000}, max ${MAX_TIMEOUT_MS / 1000}).
  --json             Machine-readable output instead of the table.
  -h, --help         Show this help.

Exit codes: 0 = a candidate reached the app, 1 = none did, 2 = usage error.`;

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function readVersion() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    return typeof parsed.version === "string" && parsed.version ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** `/apps/Foo/` → `Foo`; returns null when the value cannot be a subpath. */
function cleanSubpath(raw) {
  const trimmed = String(raw ?? "")
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .replace(/^apps\//i, "");
  if (!trimmed) return null;
  return /^[a-z0-9][a-z0-9._-]*$/i.test(trimmed) ? trimmed : null;
}

/** Accepts `https://shop.com/path`, `Shop.com` … → `shop.com`; null when invalid. */
function normalizeShop(raw) {
  let value = String(raw ?? "").trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.split("/")[0].split("?")[0].split("#")[0].replace(/\.$/, "");
  if (!value || value.includes("@") || value.includes(":")) return null;
  const label = "[a-z0-9]([a-z0-9-]*[a-z0-9])?";
  return new RegExp(`^${label}(\\.${label})+$`).test(value) ? value : null;
}

function parseArgs(argv) {
  const result = {
    shop: "",
    extraSubpaths: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false,
    errors: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      result.help = true;
      continue;
    }
    if (arg === "--json") {
      result.json = true;
      continue;
    }

    let key = arg;
    let value = null;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > -1) {
        key = arg.slice(0, eq);
        value = arg.slice(eq + 1);
      }
    }
    // Reads the next argv entry for the `--flag value` form.
    const takeNext = () => (i + 1 < argv.length ? argv[(i += 1)] : "");

    switch (key) {
      case "--shop":
      case "--store":
      case "--domain": {
        const raw = value ?? takeNext();
        if (!raw) result.errors.push(`${key} needs a value`);
        else result.shop = raw;
        break;
      }
      case "--subpath":
      case "--path": {
        const raw = value ?? takeNext();
        if (!raw) {
          result.errors.push(`${key} needs a value`);
          break;
        }
        for (const part of String(raw).split(",")) {
          if (!part.trim()) continue;
          const cleaned = cleanSubpath(part);
          if (cleaned) result.extraSubpaths.push(cleaned);
          else result.errors.push(`invalid ${key} value: "${part.trim()}"`);
        }
        break;
      }
      case "--timeout": {
        const seconds = Number.parseFloat(value ?? takeNext());
        if (!Number.isFinite(seconds) || seconds <= 0) {
          result.errors.push("--timeout needs a positive number of seconds");
          break;
        }
        result.timeoutMs = Math.min(
          MAX_TIMEOUT_MS,
          Math.max(MIN_TIMEOUT_MS, Math.round(seconds * 1000)),
        );
        break;
      }
      default: {
        if (arg.startsWith("-")) result.errors.push(`unknown option: ${arg}`);
        else if (!result.shop) result.shop = arg;
        else result.errors.push(`unexpected argument: ${arg}`);
      }
    }
  }

  return result;
}

function parseJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** `{ "_": "not_live" }` → `not_live`. */
function firstErrorCode(errors) {
  if (!errors || typeof errors !== "object") return "";
  for (const value of Object.values(errors)) {
    if (typeof value === "string" && value) return value;
  }
  return "";
}

function describeNetworkError(error) {
  const name = error && typeof error === "object" ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const code =
    (error && typeof error === "object" && error.cause && error.cause.code) ||
    (error && typeof error === "object" && error.code) ||
    "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup failed";
  if (code === "ECONNREFUSED") return "connection refused";
  if (code === "ECONNRESET") return "connection reset";
  if (code === "ETIMEDOUT") return "timeout";
  if (code === "CERT_HAS_EXPIRED") return "TLS certificate expired";
  if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return "untrusted TLS certificate";
  if (code) return String(code);
  const message = error && typeof error === "object" ? error.message : "";
  return String(message || "network error").slice(0, 60);
}

function truncate(text, max = MAX_DETAIL_LENGTH) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/* ------------------------------------------------------------------------- *
 * Probe
 * ------------------------------------------------------------------------- */

async function probe(shop, subpath, timeoutMs, version) {
  // `cx_health_probe` marks this as one of the app's OWN probes so the server's
  // recordStorefrontHit ignores it (app/services/proxy.server.ts). Without it,
  // running the selftest would stamp Setting.lastStorefrontHitAt and health
  // check 3 ("Theme extension active") would report a false pass on a store
  // where the app embed has never been enabled — exactly the state this CLI
  // exists to detect before handover. The marker is unauthenticated by design:
  // forging it can only suppress the signal, never fake it.
  const url = `https://${shop}/apps/${subpath}/api/ping?cx_health_probe=1`;
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        accept: "application/json",
        "user-agent": `cellexia-selftest/${version}`,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = describeNetworkError(error);
    return {
      subpath,
      url,
      ok: false,
      status: 0,
      ms: Date.now() - startedAt,
      appVersion: null,
      live: null,
      passwordProtected: false,
      detail:
        reason === "timeout"
          ? `no response within ${(timeoutMs / 1000).toFixed(0)}s`
          : `no response (${reason})`,
    };
  }

  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }

  const ms = Date.now() - startedAt;
  const status = response.status;
  const body = parseJson(bodyText);
  const passwordProtected = pathOf(response.url).startsWith("/password");
  const base = {
    subpath,
    url,
    status,
    ms,
    appVersion: body && typeof body.version === "string" ? body.version : null,
    live: body && typeof body.live === "boolean" ? body.live : null,
    passwordProtected,
  };

  if (status === 200 && body && body.app === APP_ID) {
    const liveLabel = base.live === null ? "unknown" : base.live ? "live" : "not live";
    return {
      ...base,
      ok: true,
      detail: `app ${APP_ID} v${base.appVersion ?? "?"} — storefront ${liveLabel}`,
    };
  }

  let detail;
  if (passwordProtected) {
    detail = "store is password-protected — Shopify never forwards to the app";
  } else if (status === 404) {
    detail = "404 — Shopify has no app proxy on this subpath";
  } else if (status === 401) {
    detail = "401 — the app rejected the signature (SHOPIFY_API_SECRET mismatch)";
  } else if (status === 403) {
    const code = firstErrorCode(body && body.errors);
    detail = code
      ? `403 ${code} — deployed build predates 1.6.0 (ping must never be gated)`
      : "403 — the request was refused";
  } else if (status === 429) {
    detail = "429 — rate limited, wait a minute and re-run";
  } else if (status >= 500) {
    detail = `${status} — the app answered with a server error`;
  } else if (status === 200 && body && typeof body.app === "string") {
    detail = `200 — another app answered (app: "${truncate(body.app, 24)}")`;
  } else if (status === 200 && body) {
    detail = "200 JSON — but not this app's ping response";
  } else if (status === 200) {
    detail = "200 HTML — Shopify served a storefront page, no proxy here";
  } else {
    detail = `HTTP ${status}`;
  }

  return { ...base, ok: false, detail };
}

/* ------------------------------------------------------------------------- *
 * Output
 * ------------------------------------------------------------------------- */

function renderTable(results) {
  const headers = ["RESULT", "SUBPATH", "HTTP", "TIME", "DETAIL"];
  const rows = results.map((result) => [
    result.ok ? "PASS" : "FAIL",
    result.subpath,
    result.status ? String(result.status) : "—",
    `${result.ms} ms`,
    truncate(result.detail),
  ]);

  const widths = headers.map((heading, column) =>
    Math.max(heading.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column])))
      .join("  ");

  console.log(line(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));
}

/** The single most likely cause, given everything the probes saw. */
function diagnose(results) {
  if (results.some((r) => r.status === 401)) {
    return "The app answered but rejected Shopify's signature — SHOPIFY_API_SECRET on the server does not match this app's client secret.";
  }
  if (results.some((r) => r.status === 403)) {
    return "The app answered 403 — the deployed build is older than 1.6.0, whose /apps/<subpath>/api/ping is never gated. Deploy this version.";
  }
  if (results.some((r) => r.passwordProtected)) {
    return "The store is password-protected, so Shopify serves the password page instead of forwarding to the app. Remove the password (or test the .myshopify.com domain of an open store).";
  }
  if (results.some((r) => r.status >= 500)) {
    return "The app is reachable but its ping route failed — check the server logs and that the database is up.";
  }
  if (results.every((r) => r.status === 0)) {
    return "Nothing answered at all — the domain is unreachable from this machine, or every request timed out.";
  }
  return "Shopify served its own pages for every candidate — no app proxy is configured on any of them.";
}

function printFailureHelp(shop, results) {
  console.log(`Most likely cause: ${diagnose(results)}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. In shopify.app.toml, add or confirm:");
  console.log("       [app_proxy]");
  console.log('       url = "https://<your-app-host>/proxy"');
  console.log('       prefix = "apps"');
  console.log(`       subpath = "${PROXY_CANDIDATES[0]}"`);
  console.log("  2. Run `npm run deploy` — the proxy only exists after a deploy.");
  console.log("  3. Confirm the app is installed on this store and its host answers publicly.");
  console.log("  4. Confirm SHOPIFY_API_SECRET matches the app's client secret.");
  console.log(`  5. Re-run: npm run selftest -- --shop=${shop}`);
  console.log("");
  console.log(
    "The same seven checks run inside the app: Dashboard → Storefront connection → Test storefront connection.",
  );
}

function printSuccessHelp(shop, result) {
  console.log(`PASS — the app proxy reaches this app at https://${shop}/apps/${result.subpath}/api`);
  console.log(`       app version ${result.appVersion ?? "unknown"}`);
  if (result.live === false) {
    console.log(
      "       The storefront widget is still hidden from visitors — press “Go live” on the app Dashboard.",
    );
  } else if (result.live === true) {
    console.log("       The storefront widget is live for visitors.");
  }
  if (result.subpath !== PROXY_CANDIDATES[0]) {
    console.log("");
    console.log(
      `Note: the proxy is configured on "${result.subpath}", not the default "${PROXY_CANDIDATES[0]}".`,
    );
    console.log(
      "      That is supported — the app detects the subpath and stores it in the shop",
    );
    console.log(
      "      metafield cellexia.proxy_path, which the theme reads. Keep shopify.app.toml",
    );
    console.log(`      and the deployed extension on "${result.subpath}".`);
  }
}

/* ------------------------------------------------------------------------- *
 * Main
 * ------------------------------------------------------------------------- */

/** Returns the process exit code; `process.exitCode` is set instead of calling
 *  `process.exit()` so piped output is never truncated. */
async function main(argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(USAGE);
    return EXIT_OK;
  }

  if (args.errors.length > 0) {
    for (const error of args.errors) console.error(`selftest: ${error}`);
    console.error("");
    console.error(USAGE);
    return EXIT_USAGE;
  }

  const shop = normalizeShop(args.shop);
  if (!shop) {
    console.error(
      args.shop
        ? `selftest: "${args.shop}" is not a valid store domain`
        : "selftest: --shop is required",
    );
    console.error("");
    console.error(USAGE);
    return EXIT_USAGE;
  }

  const version = readVersion();
  const candidates = [];
  for (const candidate of [...args.extraSubpaths, ...PROXY_CANDIDATES]) {
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }

  if (!args.json) {
    console.log(`Cellexia Reviews self-test v${version}`);
    console.log(`  store:    https://${shop}`);
    console.log(`  probing:  ${candidates.map((c) => `/apps/${c}/api/ping`).join(", ")}`);
    console.log(`  timeout:  ${(args.timeoutMs / 1000).toFixed(1)}s per candidate`);
    console.log("");
  }

  const results = [];
  for (const candidate of candidates) {
    // Sequential on purpose: parallel probes of the same storefront can trip
    // Shopify's rate limiting and would make the timings meaningless.
    // eslint-disable-next-line no-await-in-loop
    results.push(await probe(shop, candidate, args.timeoutMs, version));
  }

  const winner = results.find((result) => result.ok) ?? null;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: Boolean(winner),
          shop,
          selftestVersion: version,
          subpath: winner ? winner.subpath : null,
          appVersion: winner ? winner.appVersion : null,
          live: winner ? winner.live : null,
          results: results.map((result) => ({
            subpath: result.subpath,
            url: result.url,
            ok: result.ok,
            status: result.status,
            ms: result.ms,
            detail: result.detail,
          })),
        },
        null,
        2,
      ),
    );
    return winner ? EXIT_OK : EXIT_FAIL;
  }

  renderTable(results);
  console.log("");

  if (winner) {
    printSuccessHelp(shop, winner);
    return EXIT_OK;
  }

  console.log("FAIL — no candidate subpath reached this app.");
  console.log("");
  printFailureHelp(shop, results);
  return EXIT_FAIL;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // The probe itself swallows every network failure, so reaching this means a
  // bug or an unsupported runtime — say so instead of printing a bare stack.
  console.error("selftest: unexpected failure —", error && error.message ? error.message : error);
  console.error("Node 20.10 or newer is required (global fetch + AbortSignal.timeout).");
  process.exitCode = EXIT_FAIL;
}
