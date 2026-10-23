# framework-backups

Weekly backup of **every D1 database in the account** to the R2 bucket `framework-backups`, using D1's export API (full SQL dump: schema and data). New sites are covered automatically: no per-site bindings, no registry.

- **Schedule:** Mondays 06:17 UTC, as a scheduled Workflow (`wrangler.jsonc`). Each step retries on its own, and one failing database doesn't stop the others.
- **Output:** `d1/<database>/<YYYY-MM-DD>.sql`. A lifecycle rule deletes dumps after 90 days. D1 Time Travel separately covers the last 7 days on the Free plan.
- **Status:** `GET /status` on the Worker returns `{"ok":true,…}` with HTTP 200 when the last run finished under 8 days ago with no failures, and 503 otherwise. Point an uptime keyword monitor at it. It never returns database names.
- **Restore:** download the dump from R2 and apply it with `wrangler d1 execute <db> --remote --file <dump.sql>` into a new or empty database. Never restore over live data without the owner's approval.
- **Deploy:** `.github/workflows/deploy-backup-worker.yml`, on merge to `main` or by hand. Needs the `D1_BACKUP_TOKEN` repository secret (Account → D1 → Edit only).
- **Tests:** `npm test` (7 tests in workerd, including a full Workflow run). Status: **untested** against the real export API until the first deployed run.
