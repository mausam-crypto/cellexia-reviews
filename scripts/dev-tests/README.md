# Developer test suites

Real-code regression suites: each esbuild-bundles the actual `app/services`
code with `~/db.server` and the network stubbed, then drives it through the
scenarios that past releases broke on (money accounting, curation parity,
the QA generator's skeptic pass and content rules, AI answer parsing).

Run any of them directly:

    node scripts/dev-tests/curation-v120.test.mjs

They write their stub files next to themselves and need no database, no API
key and no network. Every suite must end `ALL ... PASS`.

(One historical suite, the brand-page one, was lost before this folder
existed — these files live in the repo now precisely so that cannot recur.)
