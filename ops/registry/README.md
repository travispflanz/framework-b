# Site registry

Not stored in this repo. `framework-b` is public, so it must never list real sites, their names or their resources.

Ops services discover what they need from the Cloudflare API instead (for example, the backup Worker lists every D1 database in the account). Each site's own private repo records its resources in `HANDOFF.md`.
