# Webhook check

A receiver for testing a site's CRM webhook end to end without sending leads to a third party. It verifies the
signature and the Idempotency-Key header the way a real CRM integration should, answers 200 or 401, and keeps only
the verdict (site, lead id, valid, time) in KV for 7 days. It never stores a lead's fields.

## Use

1. Create a KV namespace (`npx wrangler kv namespace create framework-b-webhook-check`) and put its id in
   `wrangler.jsonc`. Deploy with `npx wrangler deploy`.
2. Make a secret (`openssl rand -hex 32`). Store it on this Worker as `CRM_WEBHOOK_SECRET`, and on the site's Worker as
   `CRM_WEBHOOK_SECRET`, with `CRM_WEBHOOK_URL` set to this Worker's workers.dev URL.
3. Switch the site's mirror on (`"crm": { "webhook": true }` in `site.config.json`, by pull request), then send a lead
   or run the ops `site crm sync` workflow (it needs the same two values as repo secrets for a sync).
4. Read the verdicts with `curl -H "Authorization: Bearer <secret>" <url>/results`.

Afterwards, point the site at the real CRM's webhook URL and secret, or switch the webhook off.
