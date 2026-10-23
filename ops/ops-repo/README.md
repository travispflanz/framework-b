# Ops repo template

The owner's **private** ops repo holds every secret and runs every workflow that touches the Cloudflare account or creates site repos. `framework-b` is public: its Actions logs are public, so anything naming a site, an idea or an inbox must run in the private ops repo.

The ops repo contains only thin caller workflows (this folder's `.github/workflows/`). Each one calls a reusable workflow in `framework-b`, pinned to a ref. Replace `OWNER` with the GitHub account that owns `framework-b` when copying.

Secrets in the ops repo (Settings → Secrets and variables → Actions):

| Secret | What it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Deploy token (docs/TOKENS.md section 1) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |
| `D1_BACKUP_TOKEN` | D1 Edit only, used by the backup Worker (section 3) |
| `CF_BUILDS_TOKEN` | Workers Builds user token (section 2) |
| `GH_SITES_TOKEN` | GitHub fine-grained token that creates site repos (docs/TOKENS.md, GitHub section) |
