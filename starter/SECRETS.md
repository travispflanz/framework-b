# Secrets (names only, never values)

| Name | Where | Used for |
|---|---|---|
| `TURNSTILE_SECRET` | Worker secret | Form spam check |
| `SIGNING_SECRET` | Worker secret | Unsubscribe links, upload links |
| `MAILER_URL`, `MAILER_SECRET` | Worker secrets | Apps Script mailer: owner notifications on idea sites (and launch sites on a subdomain), the CRM Google Sheet |
| `RESEND_API_KEY` | Worker secret | Launch mode: lead confirmations and drips (a sending-only key for `mail.<domain>`, made by `site promote`) |
| `CRM_WEBHOOK_URL`, `CRM_WEBHOOK_SECRET` | Worker secrets | Only with `"crm": { "webhook": true }`: where each lead is POSTed, and the key that signs it |
| `CF_ACCESS_AUDIENCE` | Worker secret (and the previews base configuration) | Client editing: the Access application audience EmDash checks on `/_emdash/*` |
| `EMDASH_ENCRYPTION_KEY` | Worker secret | Client editing: encrypts plugin secrets EmDash stores in D1. Losing it makes them unreadable; it is not in D1 backups |
