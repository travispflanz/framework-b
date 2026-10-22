# Apps Script mailer (idea-mode email)

Idea sites live on `workers.dev`. Cloudflare can only send email from a domain set up for Email Routing in the account, so these sites send through this small script in a Google account instead. It is free and runs in Google's cloud: nothing runs on your computer.

**Status:** written, not yet tested end to end. The framework's self-test must prove it before v1.0.0.

## Set up (once, about 10 minutes)

1. Sign in to the Gmail account that should send idea-site email. A Gmail used only for this keeps your personal address off auto-replies.
2. Go to [script.google.com](https://script.google.com) → **New project**. Name it `framework-b-mailer`.
3. Replace the contents of `Code.gs` with the `Code.gs` in this folder. Save.
4. **Project Settings → Script properties → Add property:** name `MAILER_SECRET`, value a long random string (the agent can generate one for you).
5. **Deploy → New deployment → Select type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, approve the permissions (it asks to send email as you), and copy the **Web app URL**.
6. Give the agent the web app URL and the secret. It stores them as Worker secrets `MAILER_URL` and `MAILER_SECRET`.

"Anyone" means anyone can reach the URL, but the script refuses any request without the secret.

## How a Worker calls it

The Worker POSTs JSON (see the comment at the top of `Code.gs`) without following redirects. Apps Script runs `doPost` and answers `302` with a `Location`. The Worker then GETs that location to read the result: `{ "ok": true, ... }`.

If the mailer fails or the daily quota runs out, the lead is still saved in D1 and shown in `/admin`. The failure is recorded on the lead row.

## Limits

- 100 recipients a day for a personal Gmail account, shared across every idea site. A notification counts as 1, and an auto-reply as 1 more ([quotas](https://developers.google.com/apps-script/guides/services/quotas)).
- Auto-replies come from the Gmail address that owns the script.

## Changing the script

Edit `Code.gs`, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. The URL stays the same.
