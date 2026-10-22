# One-time setup

Everything here is done once per Cloudflare account, not per site. **H** = the owner does it (dashboard, payment, email click or consent). **A** = the agent can do it once the owner's steps are done. Mark each row done with the date.

## Accounts

| # | Step | Who | Link | Done |
|---|---|---|---|---|
| 1 | Cloudflare account with two-factor authentication and a verified email | H | [Sign up](https://dash.cloudflare.com/sign-up) | |
| 2 | Choose the account's `workers.dev` subdomain (idea sites live under it) | H or A | Workers & Pages → Overview | |
| 3 | GitHub account with two-factor authentication | H | [GitHub 2FA](https://docs.github.com/en/authentication/securing-your-account-with-two-factor-authentication-2fa) | |
| 4 | Install the **Cloudflare Workers and Pages** GitHub app, with access to the repos it should build | H | Workers & Pages → a Worker → Settings → Builds → Connect | |
| 5 | Install the **Claude** GitHub app, with access to `framework-b` and each site repo (cloud Claude sessions) | H | GitHub → Settings → Applications | |
| 6 | Create the deploy token and the Workers Builds token, as listed in `TOKENS.md`. Give each agent environment its own copy | H | [Create API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) | |
| 7 | Create the Zero Trust organisation (Free plan; a card is required) for the Access logins | H | [Cloudflare One setup](https://developers.cloudflare.com/cloudflare-one/setup/) | |
| 8 | Turn on R2 (card on file; usage stays inside the free tier at small scale) | H | Dashboard → R2 | |
| 9 | Verify the owner's inbox as an Email Routing destination. Used by launch sites; one click in the verification email | H | [Destination addresses](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/) | |

## Email for idea sites

| # | Step | Who | Link | Done |
|---|---|---|---|---|
| 10 | Pick the Gmail account that sends idea-site email. A Gmail used only for this keeps your personal address off auto-replies | H | | |
| 11 | In that account, create the Apps Script mailer from `ops/apps-script-mailer/`, set its secret, and deploy it as a web app. Give the web app URL to the agent | H, with step-by-step instructions in that folder | [Apps Script web apps](https://developers.google.com/apps-script/guides/web) | |
| 12 | Store the URL and secret as Worker secrets for idea sites | A | | |

## Email for launch sites

| # | Step | Who | Link | Done |
|---|---|---|---|---|
| 13 | Create a Resend account | H | [Resend](https://resend.com/signup) | |
| 14 | Per launch site: create a temporary full-access Resend key, let the agent set up `mail.<domain>` and a sending-only key, then delete the full-access key | H, then A, then H | [Resend domains](https://resend.com/docs/dashboard/domains/introduction) | per site |

## Monitoring

| # | Step | Who | Link | Done |
|---|---|---|---|---|
| 15 | UptimeRobot account and API key (free plan) | H | [UptimeRobot](https://uptimerobot.com) | |

## Only when buying domains

| # | Step | Who | Link | Done |
|---|---|---|---|---|
| 16 | Billing profile, a capped virtual card, default registrant contact, and acceptance of the registration agreement | H | [Registrar](https://developers.cloudflare.com/registrar/) | |

## Per launch site: settings no API reaches

The agent posts this list with direct links when a site is promoted. Each item is recorded in the site's `HANDOFF.md` as owner-attested, with the date.

- Crawler Hints on (zone → Caching → Configuration)
- Search Console: confirm the domain property, then submit `sitemap.xml`
- Bing Webmaster Tools: import from Search Console
- Registrar auto-renew: choose on or off deliberately
