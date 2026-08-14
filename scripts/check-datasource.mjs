/**
 * Boot guard: DATABASE_URL set but ignored (SPEC-1.19 deploy audit).
 *
 * prisma/schema.prisma ships with a hardcoded SQLite path so the app works
 * out of the box. Every host walkthrough in docs/INSTALL.md §5 tells the
 * developer to set DATABASE_URL — which Prisma SILENTLY IGNORES until the
 * datasource block is switched to env("DATABASE_URL") (§4). The failure mode
 * is invisible and expensive: the app boots, works, and loses every review on
 * the next redeploy because the database was on the container's ephemeral
 * disk the whole time.
 *
 * This runs as part of `npm run setup` (and therefore `npm run docker-start`)
 * and turns that silent data loss into a loud, actionable boot failure.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "prisma", "schema.prisma");

const databaseUrl = (process.env.DATABASE_URL ?? "").trim();
if (!databaseUrl) process.exit(0); // nothing set — the shipped default applies

let schema = "";
try {
  schema = fs.readFileSync(SCHEMA, "utf8");
} catch {
  process.exit(0); // no schema to inspect; prisma itself will complain
}

const datasource = /datasource\s+db\s*\{([\s\S]*?)\}/.exec(schema)?.[1] ?? "";
const readsEnv = /url\s*=\s*env\(\s*["']DATABASE_URL["']\s*\)/.test(datasource);
if (readsEnv) process.exit(0); // correctly wired

const hardcoded = /url\s*=\s*"([^"]+)"/.exec(datasource)?.[1] ?? "(unknown)";
console.error(`
────────────────────────────────────────────────────────────────────────────
 DATABASE_URL is set but Prisma is IGNORING it.

   DATABASE_URL      = ${databaseUrl}
   schema.prisma url = "${hardcoded}"   <-- hardcoded, wins

 The app would start normally and write to "${hardcoded}" instead. On a
 container host that path is ephemeral, so every review would be lost on the
 next redeploy — silently.

 Fix (docs/INSTALL.md §4), in prisma/schema.prisma:

   datasource db {
     provider = "sqlite"                  // "postgresql" for Postgres
     url      = env("DATABASE_URL")
   }

 Then redeploy. Postgres also needs the provider changed AND a fresh
 migration generated (INSTALL.md §4 Option B).

 Deliberately keeping the hardcoded path? Unset DATABASE_URL and this check
 passes.
────────────────────────────────────────────────────────────────────────────
`);
process.exit(1);
