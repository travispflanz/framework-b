# Apps Script mailer (idea-mode email)

Idea sites live on `workers.dev`. Cloudflare can only send email from a domain set up for Email Routing in the account, so these sites send through this small script in a Google account instead. It is free and runs in Google's cloud: nothing runs on your computer.

**Status:** in use since 2026-10-27. Owner notifications from idea sites and from launch sites on a domain whose mail is elsewhere, lead auto-replies on idea sites, and the CRM Google Sheet all went through it live.

## Set up (once, about 10 minutes)

1. Sign in to the Gmail account that should send idea-site email. A Gmail used only for this keeps your personal address off auto-replies.
2. Go to [script.google.com](https://script.google.com) → **New project**. Name it `framework-b-mailer`.
3. Replace the contents of `Code.gs` with the `Code.gs` in this folder. Save.
4. **Project Settings → Script properties → Add property:** name `MAILER_SECRET`, value a long random string (the agent can generate one for you).
5. **Deploy → New deployment → Select type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone**
   - Click **Deploy**, approve the permissions (it asks to send email as you), and copy the **Web app URL**.
6. In the ops repo (GitHub → Settings → Secrets and variables → Actions → New repository secret), add `MAILER_URL` (the web app URL) and `MAILER_SECRET` (the secret). From then on `site create` gives every new site the mailer. For a site made earlier, run the ops workflow **site mailer**: it sends a test notification and opens a pull request that turns notifications on.

"Anyone" means anyone can reach the URL, but the script refuses any request without the secret.

## How a Worker calls it

The Worker POSTs JSON (see the comment at the top of `Code.gs`) without following redirects. Apps Script runs `doPost` and answers `302` with a `Location`. The Worker then GETs that location to read the result: `{ "ok": true, ... }`.

If the mailer fails or the daily quota runs out, the lead is still saved in D1 and shown in `/admin`. The failure is recorded on the lead row.

## Limits

- 100 recipients a day for a personal Gmail account, shared across every idea site. A notification counts as 1, and an auto-reply as 1 more ([quotas](https://developers.google.com/apps-script/guides/services/quotas)).
- Auto-replies come from the Gmail address that owns the script.

## Changing the script

Edit `Code.gs`, then **Deploy → Manage deployments → Edit → Version: New version → Deploy**. The URL stays the same.

## Updating it for the CRM mirror (Google Sheet)

The Sheet mirror needs the 2026-10-27 version of `Code.gs` and permission to create a spreadsheet:

1. Open the project at [script.google.com](https://script.google.com), replace `Code.gs` with the current one from this folder, and save.
2. **Deploy → Manage deployments →** pencil (**Edit**) **→ Version: New version → Deploy.** Approve the new permission (Google Sheets / Drive) when Google asks. The `/exec` URL stays the same.
3. The first lead a site with `"crm": { "sheet": true }` receives creates the spreadsheet **Framework B leads** in this account's Drive, with one tab per site.
