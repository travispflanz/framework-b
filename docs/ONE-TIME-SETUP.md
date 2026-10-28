# One-time setup

Everything here is done once per Cloudflare account, not per site. It takes about an hour, most of it creating
tokens. **H** = you do it (dashboard, payment, email click or consent). **A** = an agent can do it once your steps
are done. Every service here is on its free plan; two of them (Cloudflare Zero Trust and R2) want a card on file.

Keep your own record of what's done (for example in your ops repo's README); this page is the same for everyone.

## 1. Accounts

| # | Step | Who | Link |
|---|---|---|---|
| 1 | Cloudflare account with two-factor authentication and a verified email | H | [Sign up](https://dash.cloudflare.com/sign-up) |
| 2 | Choose the account's `workers.dev` subdomain (idea sites live under it, as `<site>.<subdomain>.workers.dev`) | H | Workers & Pages → Overview |
| 3 | GitHub account with two-factor authentication | H | [GitHub 2FA](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa) |
| 4 | Install the **Cloudflare Workers and Pages** GitHub app with access to **all repositories**, so Workers Builds can connect each new site repo without a manual step | H | Workers & Pages → a Worker → Settings → Builds → Connect |
| 5 | Give your AI agent GitHub access to `framework-b` (or your fork), your ops repo and the site repos. For cloud Claude sessions this is the **Claude** GitHub app; for other agents, a fine-grained token or the `gh` CLI signed in | H | GitHub → Settings → Applications |
| 6 | Create the Zero Trust organisation (Free plan; a card is required) for the Access logins on `/admin`, previews and the editor | H | [Cloudflare One setup](https://developers.cloudflare.com/cloudflare-one/setup/) |
| 7 | Turn on R2 (card on file; usage stays inside the free tier at small scale) | H | Dashboard → R2 |
| 8 | Verify your inbox as an Email Routing destination, used by launch sites to email you about leads: one click in the verification email | H | [Destination addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) |

## 2. Tokens and the ops repo

| # | Step | Who | Link |
|---|---|---|---|
| 9 | Create the Cloudflare deploy token, the Workers Builds token and the D1 backup token, and the GitHub site repo token | H | `docs/TOKENS.md` (exact permissions and click paths) |
| 10 | Create your **private** ops repo from `ops/ops-repo/`, replace `OWNER` in its workflows, and add the secrets | H, or A with your tokens | `ops/ops-repo/README.md` |
| 11 | Run the ops workflow **verify secrets**, then **deploy backup worker** | H or A | your ops repo → Actions |

## 3. Email for idea sites (optional, recommended)

Without it, idea sites still store every lead, but nobody is emailed about them.

| # | Step | Who | Link |
|---|---|---|---|
| 12 | Pick the Gmail account that sends idea-site email. A Gmail used only for this keeps your personal address off auto-replies | H | |
| 13 | In that account, create the Apps Script mailer from `ops/apps-script-mailer/`, set its secret, deploy it as a web app, and store the URL and secret as the ops repo secrets `MAILER_URL` and `MAILER_SECRET` | H, with step-by-step instructions in that folder | [Apps Script web apps](https://developers.google.com/apps-script/guides/web) |
| 14 | Every site then gets them as Worker secrets: `site create` for new sites, the **site mailer** workflow for sites made before step 13, **site promote** for launch sites that keep the mailer | A | |

## 4. Email for launch sites (optional)

Needed for lead auto-replies, newsletters and drips on a site with its own domain. Owner notifications on a launch
site work without it.

| # | Step | Who | Link |
|---|---|---|---|
| 15 | Create a Resend account (Free: 3,000 emails a month, 100 a day, 3 sending domains, marketing email to 1,000 contacts; [quotas](https://resend.com/docs/knowledge-base/account-quotas-and-limits), checked 2026-10-27) | H | [Resend](https://resend.com/signup) |
| 16 | Create a **full-access** Resend key and store it as the ops repo secret `RESEND_ADMIN_KEY`. **site promote** uses it to set up `mail.<domain>` and a sending-only key for that one site; **site newsletter** uses it for contacts and broadcasts. If you'd rather not keep a full-access key, delete it after each promote and add it again before a newsletter send | H | [API keys](https://resend.com/api-keys) |

## 5. Monitoring (optional, recommended)

| # | Step | Who | Link |
|---|---|---|---|
| 17 | UptimeRobot account (Free: 50 monitors, 5-minute checks) and its **main** API key as the ops repo secret `UPTIMEROBOT_API_KEY`. Every site then gets two monitors; alerts go to your UptimeRobot alert contacts | H | [UptimeRobot](https://uptimerobot.com) |
| 18 | Point one keyword monitor at the backup Worker's `/status` (keyword `"ok":true`), so a failed or missed backup alerts you | H or A | `ops/backup-worker/README.md` |

## 6. Only when buying domains

Framework B never buys anything on its own. A domain you already have in Cloudflare needs none of this.

| # | Step | Who | Link |
|---|---|---|---|
| 19 | Billing profile, a capped virtual card, default registrant contact, and acceptance of the registration agreement | H | [Registrar](https://developers.cloudflare.com/registrar/) |

## Per launch site: settings no API reaches

**site promote** writes these into the site's `HANDOFF.md` as a checklist with direct links. Tick each one there, with the date (owner-attested).

- Crawler Hints on (zone → Caching → Configuration)
- Search Console: confirm the domain property, then submit `sitemap-index.xml`
- Bing Webmaster Tools: import from Search Console
- Registrar auto-renew: choose on or off deliberately
