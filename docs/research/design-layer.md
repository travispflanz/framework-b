# Tokens, tiles and detectors beat AI sameness

**Framework B's design layer works best as a fixed contract, not a better prompt.** Before any page is built, the agent writes a `PRODUCT.md` (who the site is for and what visitors should do) and a `DESIGN.md` in Google's open format (normative YAML tokens plus eight prose sections). The owner chooses those tokens by reacting to rendered samples: slider defaults, two-option element pairs, then three HTML style tiles. They are never asked to describe taste in words. Deterministic gates then hold the build to the contract: Google's `design.md lint`, Impeccable's 61-rule detector, a copy lint, axe, Lighthouse CI and Playwright layout checks. A vision-model critique is capped at three rounds and only accepts a revision that measurably beats the version before it. This matters because unguided output has converged on a recognizable look. A headless scan of 1,590 Show HN sites found **54% showing two or more AI design patterns** ([Krebs](https://adriankrebs.ch/blog/design-slop/)). Telling a model to "avoid the AI look" just moves it to a second generation of defaults: cream, serif and terracotta; near-black with acid green; broadsheet hairlines ([Anthropic frontend-design](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)). Everything proposed here is free or optional-paid, installs into the repo or the cloud container rather than the owner's machine, and works with any agent that reads `AGENTS.md`. The owner's job comes to roughly 15–20 minutes of picking and confirming, plus approving the preview. That figure is an estimate, not a measurement.

## A free, agent-agnostic toolchain already covers taste, tokens and detection

Design affects more than looks. In the Stanford credibility study, "design look" was the most-mentioned credibility factor, at **46.1% of comments** ([Fogg et al.](https://simson.net/ref/2002/stanfordPTL.pdf)). The tooling now available splits into six layers. Each layer has a clear free default.

### Skills supply the process; Impeccable supplies the enforcement

Three free skills lead. **Anthropic's frontend-design skill** (Apache-2.0) is the best *process* skill. It makes the agent write a compact token plan before coding: 4–6 named hex colors, display, body and utility faces, ASCII wireframes and one signature element. It then has the agent review that plan for anything that "reads like the generic default you would produce for any similar page." It names the current AI clusters to avoid and requires screenshot self-critique ([SKILL.md](https://raw.githubusercontent.com/anthropics/skills/main/skills/frontend-design/SKILL.md)).

**Impeccable** (npm `impeccable` **4.7.0**, Apache-2.0, published 2026-10-19) adds 24 commands. These include `init` (writes `PRODUCT.md`), `document` (writes `DESIGN.md`), `critique`, `audit`, `polish`, `bolder` and `quieter`. It also ships a deterministic `npx impeccable detect` that needs **no LLM or API key**, emits `--json`, and exits 0 when clean, 2 on findings and 1 when a target can't be scanned. It installs into Claude Code, Codex, Cursor, Gemini CLI, Copilot, OpenCode, Hermes Agent and Antigravity ([GitHub](https://github.com/pbakaus/impeccable); [npm](https://registry.npmjs.org/impeccable)).

**Taste Skill** (MIT, v2.1) runs its own loop. It deals three random directions, picks one, builds with credited open-licensed images, checks the page in a browser at three widths and revises up to three times. That takes about **30–45 minutes per build** and needs Node 22+ and Chromium ([GitHub](https://github.com/Leonxlnx/taste-skill)). Vercel's `web-design-guidelines` is a review skill rather than a taste generator. It pulls the latest Web Interface Guidelines on each run and reports `file:line` findings ([llmbase](https://llmbase.ai/skills/vercel-labs/web-design-guidelines/)).

The right combination is frontend-design for the plan, Impeccable for commands and the detector, and Vercel's guidelines as an `AGENTS.md` section. Taste Skill should be an alternative, not a fourth layer. Its random-direction dealing would compete with the owner's tile choice. Note that no independent benchmark rates any of these skills; the evidence is adoption and practitioner reports.

### MCP servers matter less than expected for headless builds

Most design MCPs assume a human design file or a live browser tab. The **shadcn MCP** (CLI `shadcn` 4.22.1, MIT) needs no auth. It browses and installs from any registry that follows the shadcn spec ([shadcn docs](https://ui.shadcn.com/docs/mcp)).

**Google Stitch** is the most headless-friendly generative tool. It authenticates with an API key, generates and edits screens, and exports HTML plus a `design.md`. It also has an Apache-2.0 SDK (`@google/stitch-sdk` 0.3.5) ([MindStudio](https://www.mindstudio.ai/blog/google-stitch-mcp-coding-agents/); [npm](https://registry.npmjs.org/@google/stitch-sdk)). Users do report problems getting the API key working ([Google AI forum](https://discuss.ai.google.dev/t/stitch-mcp-not-working-with-api-key/120933)).

Figma's official remote MCP defaults to OAuth, and write-to-canvas "will eventually become a usage-based paid feature" ([Figma Help](https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server)). The community Framelink server (`figma-developer-mcp` 0.13.2, MIT) works with a plain API token, which makes it the headless route when an owner already has a Figma file ([npm](https://registry.npmjs.org/figma-developer-mcp)). **Penpot's MCP is not headless**, because both its hosted and local servers need the plugin running in an open browser tab ([Penpot Help](https://help.penpot.app/mcp/)). 21st.dev generates React components ([mcp.directory](https://mcp.directory/blog/21st-dev-magic-mcp-complete-guide-2026)), which is a poor fit for zero-JS Astro pages.

The useful paid option is the reference-library MCPs. **Refero** offers 8,000 calls a month on paid plans, with a Bearer-token option ([Refero docs](https://doc.refero.design/mcp/getting-started.md)). **Mobbin** offers 621,500+ screens, but they are mostly mobile ([WBOC](https://www.wboc.com/online_features/press_releases/mobbin-launches-mcp-server-giving-ai-tools-621-500-real-app-screens-to-reference/article_ffe043e0-a91b-5bb4-9128-21c46942e00c.html)). Both should stay opt-in.

### Palettes and type are best computed locally

Only one palette API proved headless-safe from a cloud container. **Huemint** (`POST https://api.huemint.com/color`) returned scored palettes from a contrast-adjacency matrix with no key ([Huemint](https://huemint.com/)). tints.dev returned a Cloudflare bot challenge from cloud IPs ([tints.dev](https://www.tints.dev/)). That supersedes the earlier plan to make tints.dev the default.

The robust pattern takes the accent from the owner's logo when there is one, or from Huemint or the frontend-design token plan when there isn't. A local OKLCH scale generator then expands it, for example the `culori` library (its version and API were not verified in this research). The result is written into Tailwind 4's CSS-first `@theme`. No type-pairing API turned up, so pairings come from a curated pool (next section).

Fonts are self-hosted through Astro's built-in Fonts API with the Fontsource provider. Astro then handles download, caching, fallbacks and preload links ([Astro fonts guide](https://docs.astro.build/en/guides/fonts)). Icons come from `astro-icon` with `@iconify-json/*` sets (the `@iconify/json` bundle is at 2.2.546, MIT). The agent can search the keyless Iconify API to choose them ([npm](https://registry.npmjs.org/@iconify/json); [Iconify API](https://api.iconify.design/search?query=film&limit=5)).

### Galleries and datasets: reference by hand, not by scraping

No major free gallery has confirmed agent access. Land-book, Godly, Awwwards, SiteInspire and One Page Love had no verified API or scraping permission, so treat bulk collection as off-limits. The open datasets are permissively licensed but dated and generic. WebSight is synthetic Tailwind HTML under CC-BY-4.0, last modified in 2024 ([HF](https://huggingface.co/datasets/HuggingFaceM4/WebSight/blob/97989cc94513f087c09a6b3308b43cf840137ffd/README.md?code=true)). Design2Code is real pages under ODC-BY, built as a screenshot-to-code benchmark ([GitHub](https://github.com/NoviScl/Design2Code)). They suit fidelity testing, not taste. The free, legal input is **human-curated references**: two or three URLs the owner likes, each with *why*, written into `PRODUCT.md`.

### Astro components: borrow behavior, hand-compose the sections

**Starwind UI** (CLI `starwind` 3.4.0, MIT) is the best native fit. It offers 45+ Tailwind-4 components built as `.astro` files with vanilla JS, installed shadcn-style ([npm](https://registry.npmjs.org/starwind); [starwind.dev](https://starwind.dev/)). Its theme page still says "Astro v6 ready," so smoke-test it against Astro 7.4.2 ([Astro Themes](https://astro.build/themes/details/starwind-ui/)). `accessible-astro-components` 5.8.1 (MIT) is the WCAG-first alternative ([npm](https://registry.npmjs.org/accessible-astro-components)). DaisyUI 5, Flowbite 4 and Preline 5 work but read as generic. Preline adds a "Fair Use License" ([npm](https://registry.npmjs.org/preline)), and Tailwind Plus Elements is proprietary ([npm](https://registry.npmjs.org/@tailwindplus/elements)).

The design implication is that libraries supply dialogs, tabs, accordions and form controls. The *sections* (hero, proof, CTA band) are where sameness shows, so Framework B should own a style-agnostic section library driven by tokens. This research changes the earlier position: AstroWind ([GitHub](https://github.com/arthelokyo/astrowind)) becomes scaffolding to borrow from, not the visual base. A widely shared theme becomes its own template tell.

### Images: owner photos first, open-licensed second, generated only for abstraction

**Openverse** returned CC-licensed results with no key, each carrying `license`, `license_version`, `creator` and `foreign_landing_url` ([Openverse API](https://api.openverse.org/v1/)). That makes it the cleanest automated stock source, as long as the agent writes credits. The Unsplash *API* requires hotlinking, download-event pings and UTM-tagged attribution ([Unsplash API guidelines](https://help.unsplash.com/api-guidelines/unsplash-api-guidelines)). That conflicts with self-hosting through Astro's image pipeline, so download Unsplash photos manually under the photo license instead ([Unsplash License](https://unsplash.com/license)). Pexels requires a key ([Pexels API](https://www.pexels.com/api/)).

**Workers AI** gives 10,000 free neurons a day ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)). By calculation from that page, that is about 170 `flux-1-schnell` 1024² images a day, or about 7 from `flux-2-klein-9b`. Images are generated at build time and committed. Generated images are for texture and abstraction only. **Never generate people, premises, testimonials or "our team"**: presenting fabricated depictions as real is a trust and honesty failure, whatever the license.

## Ten named styles give owners vocabulary, but each has a default trap

NN/g tested prompts for an AI landing page. "In a neobrutalist style" beat a description of the same traits, which in turn beat "trendy." **Naming the style produced the best result** ([NN/g](https://www.nngroup.com/articles/vague-prototyping)). That is the case for giving owners and agents a named menu. The table compresses the menu to what an agent needs to write tokens.

It adds one column the sources don't put together: the **trap** each style falls into when rendered at its median. Several named styles sit right next to the second-generation AI clusters. Warm organic drifts into cream plus terracotta. Editorial drifts into the italic-serif broadsheet. Technical drifts into near-black with an acid accent. Impeccable flags each of these: "Cream/beige palette," "Italic serif display headline" and "Dark mode with glowing accents" ([impeccable.style/slop](https://impeccable.style/slop)). The styles themselves aren't banned. Each style's *default rendition* must be twisted by something specific to the subject, or recorded in `DESIGN.md` as a deliberate choice.

| Style | Token signature | Good fit | Trap to avoid |
|---|---|---|---|
| Editorial | Display serif + neutral grotesk body, ratio ~1.33–1.5, radius 0–4px, one muted accent | Professional services, authors, arts, nonprofits with stories | Italic-serif hero + hairline broadsheet (AI cluster 3) |
| Swiss / international | One neo-grotesk family, strict 12-col grid, radius 0, mono + one signal color | Architects, studios, B2B, events | Cold for family/health audiences |
| Neo-brutalist | Heavy grotesk/mono, 2–3px black borders, hard offset shadows, 3–4 colors | Indie products, creators, waitlists | Yellow+cyan contrast failures; NN/g says limit palette and keep hierarchy ([NN/g](https://www.nngroup.com/articles/neobrutalism)) |
| Minimal / luxury | Refined serif or light sans, very generous asymmetric space, radius 0 | Boutique hospitality, salons, interiors, jewelry | Hides phone/CTA for task-driven visitors |
| Warm organic | Soft serif or rounded humanist sans, earth tones, radius 16–32px | Wellness, food, makers, family services | Cream #F4F1EA + terracotta (AI cluster 1); generic blobs |
| Playful / illustrative | Characterful display, bright multi-hue, outlines and stickers | Kids, education, pets, community events | Generic stock illustration; emoji icons |
| Technical | Grotesk + mono, dense 8px grid, radius 4–8px, optional dark | SaaS, APIs, IT services | Near-black + acid green; Inter/Geist by reflex |
| Retro / Y2K | Chrome or pixel display (headlines only), neon on dark | Music, fashion, nightlife, festivals | Dates fastest; flashing violates WCAG 2.3.1 |
| Bento (layout modifier) | Varied tile spans, one gap token, radius 12–24px | Feature/service overviews, portfolios | Many equal tiles kill hierarchy; NN/g caps "big" elements at 2 ([NN/g](https://www.nngroup.com/articles/visual-hierarchy-ux-definition)) |
| Glass / soft UI (surface modifier) | Translucent surfaces over controlled solid backgrounds | Sparing accents in tech launches | Text over photos; readability ([NN/g](https://www.nngroup.com/articles/glassmorphism)) |

Style mappings to industries in vendor trend posts, such as GoDaddy's "Floating Minimalism" for beauty and travel or "Bento Blocks" for wellness and retail ([GoDaddy](https://www.godaddy.com/resources/skills/web-design-trends)), show what is being promoted, not what has been tested. No study compares conversion or trust across named styles.

### A curated free font pool, with "needs a reason" flags

Free pairings per style: Editorial uses Newsreader or Fraunces with Switzer. Swiss uses Schibsted Grotesk alone. Neo-brutalist uses a heavy grotesk with JetBrains Mono. Warm organic uses Fraunces (soft axis) with Figtree. Playful uses Bricolage Grotesque with Nunito Sans. Technical uses IBM Plex Sans with Plex Mono. Health and public-service bodies use Atkinson Hyperlegible, which was designed for low-vision readers ([BonFX](https://bonfx.com/what-fonts-go-with-inter)). Typewolf's most-featured faces in 2025 skew to Swiss neo-grotesques and editorial serifs (Söhne, Neue Montreal, Editorial Old, Signifier) ([Typewolf](https://www.typewolf.com/all-fonts)), and Switzer and Satoshi on Fontshare are their free analogues ([DiverseKit](https://diversekit.com/blog/geist-vs-inter)).

Some faces need a stated reason in `DESIGN.md` before they can be used. **Inter and Geist** are Impeccable rules unless product-specific ([impeccable.style/slop](https://impeccable.style/slop)). **Space Grotesk, Instrument Serif and Geist combinations** appeared in the Krebs pattern set ([Krebs](https://adriankrebs.ch/blog/design-slop/)). Plus Jakarta Sans "shot up in popularity" and is becoming common itself ([Starosta](https://starosta-agency.com/en/best-free-fonts-2026-google-fonts)). The flag replaces the earlier blanket ban: Inter "is rarely the wrong font" for dense UI ([DiverseKit](https://diversekit.com/blog/geist-vs-inter)), so the rule targets marketing headlines chosen by reflex. Cap each site at two families and about four weight files.

### Section patterns follow the argument, not a template order

Research supports a handful of hard rules. Keep the tagline and headline static and immediately visible ([NN/g homepage](https://www.nngroup.com/articles/homepage-design-principles)). Prefer a static hero to a carousel, and if a carousel is unavoidable, keep it to five or fewer frames ([NN/g carousels](https://www.nngroup.com/articles/designing-effective-carousels)). Link proof to third-party reviews, because users cross-check ([NN/g trust](https://www.nngroup.com/articles/trustworthy-design)). List only FAQs that are genuinely frequent, and answer visitors' first questions on About ([NN/g About Us report](https://media.nngroup.com/media/reports/free/Presenting_Company_Information_on_Corporate_Websites_3rd_Edition.pdf)). Use a fat footer as fallback navigation ([NN/g Young Adults report](https://media.nngroup.com/media/reports/free/Designing_for_Young_Adults_3rd_Edition.pdf)).

Everything else is convention. A local-service homepage defaults to hero (what, where, for whom, one CTA, trust strip), services, specific testimonials linked to reviews, how it works, differentiators, real work, service area, FAQ, final CTA, fat footer. An idea page defaults to problem-framed hero with one field, problem, solution, who it's for, honest early proof, FAQ, repeat CTA. CXL's guidance is to place proof "where doubt peaks most," right after the value proposition and near the CTA ([CXL](https://cxl.com/blog/landing-page-infrastructure)). The section order is itself a known AI tell: "hero, features grid, social proof, pricing, FAQ, footer" every time ([CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same)). So the agent should let the page's argument reorder sections rather than apply one fixed sequence.

### Credible 2026 trends are the ones usability research doesn't contradict

The durable trends are the ones that agree with long-standing research: type-led hierarchy, tokens with rem-based fluid type, container queries, modular layouts as one option, restrained motion gated by `prefers-reduced-motion`, and visible accessibility. Smashing frames 2026 as intent-based design with `clamp()` headings and tokens as "the bridge between design and code" ([Smashing](https://www.smashingmagazine.com/2026/01/rethinking-pixel-perfect-web-design)). WCAG 2.2 adds AA criteria that shape visuals directly: focus not obscured by sticky headers, and 24×24 px minimum targets ([W3C](https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22)). Fluid type must stay rem-based to pass 200% resize ([Smashing](https://www.smashingmagazine.com/2023/11/addressing-accessibility-concerns-fluid-type)).

The fads fail research directly. NN/g found scrolljacking "leads to more user pain than benefits," that scroll-triggered headline animation delays users, and that bounce likelihood rises 32% as load time goes from 1 s to 3 s ([NN/g scrolljacking](https://www.nngroup.com/articles/scrolljacking-101); [NN/g homepage](https://www.nngroup.com/articles/homepage-design-principles)). The "immersive 3D" enthusiasm comes almost entirely from vendor listicles. The agency counter-position, CSS depth rather than heavy 3D because large assets "degrade core web vitals," fits a static Workers site ([Fireart](https://fireart.studio/blog/the-best-web-design-trends)). Distinctiveness is itself the most credible 2026 trend. NN/g's line is the design brief for this whole layer: "If you can generate something... using AI with little effort, so can your competitors" ([NN/g](https://www.nngroup.com/articles/ux-reset-2025)).

## Anti-slop takes bans, a positive token file and a detector together

The tells are stable and fall into four groups. **Palette:** purple or indigo gradients and glows, cyan on dark, grey-on-dark body text. **Type:** Inter everywhere, an italic serif accent word, all-caps eyebrows. **Layout:** a centered hero with a pill badge and two buttons, three identical icon-topped cards, 01/02/03 markers that aren't real sequences, stat banners, nested cards. **Decoration:** glassmorphism, side-stripe borders, emoji icons, ornamental status dots ([Krebs](https://adriankrebs.ch/blog/design-slop/); [Fountain Institute](https://www.thefountaininstitute.com/blog/signs-vibe-coded-ui); [Superdesign](https://superdesign.dev/blog/fix-generic-ai-landing-page)).

The purple has a traceable origin. Tailwind UI's 2020 demos used `bg-indigo-500` as a neutral placeholder, and Tailwind sets no primary color, so models fill the gap with the median of every tutorial ([prg.sh](https://prg.sh/ramblings/Why-Your-AI-Keeps-Building-the-Same-Purple-Gradient-Website); [CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same)).

Bans alone fail. CodeMySpec observes that anti-slop prompting "tends to produce a new common look." Anthropic's skill now lists those second-generation clusters explicitly, and adds that "extra animation contributes to the feeling that the design is AI-generated" ([SKILL.md](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md)). The fix has three parts that must ship together:

1. **A ban list** in `AGENTS.md`, so every agent sees it.
2. **A positive, subject-derived token file** (`DESIGN.md`), so the model has something specific to converge on.
3. **A detector that checks the rendered page against both.** The CodeMySpec author concedes that "nothing verifies that the rendered page matches the design system." Impeccable's DESIGN.md rules close exactly that gap: they flag any font, color, radius or size outside the file ([impeccable.style/slop](https://impeccable.style/slop)).

The Krebs scan showed that palette, type and layout tells can be measured from computed styles alone, with **5–10% false positives** and no screenshots or LLM ([Krebs](https://adriankrebs.ch/blog/design-slop/)). Deterministic detection is therefore the right first gate. Impeccable's catalog covers visual details, typography, color, layout, motion, copy, imagery and general quality. Some rules need a browser: covered text, overflow, line length over 65–75 characters, entrance animations that never fire ([impeccable.style/slop](https://impeccable.style/slop)). One caveat: the package is now a launcher for a checksum-verified binary. Its thresholds can't be audited, and its first run needs egress to GitHub, so **pin the version and vendor `IMPECCABLE_BIN`** in CI.

Two mechanical blocks strengthen the gate. First, Stylelint with `stylelint-declaration-strict-value` 1.12.1 forces `var(--…)` tokens for color, font, radius and shadow ([npm](https://www.npmjs.com/package/stylelint-declaration-strict-value)). Second, Tailwind 4 lets `@theme` reset the default palette (`--color-*: initial`), which should make `indigo-*` classes fail to compile. That second behavior is from prior knowledge and must be verified against Tailwind 4.3 docs before relying on it.

### A copy lint catches the words that read as machine-written

Copy tells are lexical and structural. The vocabulary includes delve, tapestry, testament, pivotal, underscore, landscape, foster and crucial ([Beutler Ink](https://www.beutlerink.com/blog/how-to-spot-ai-writing)), plus empower, unlock, transform ([CodeMySpec](https://codemyspec.com/blog/vibe-coded-websites-look-the-same)) and "world-class" ([Impeccable](https://impeccable.style/slop)). The structures include negative parallelism ("not X, but Y"), rule-of-three lists, "From X to Y" false ranges, compulsive summaries, emoji in headers, em-dash overuse ([Beutler Ink](https://www.beutlerink.com/blog/how-to-spot-ai-writing)), and the mad-lib headline "The AI-powered [X] for modern [Y]" ([Superdesign](https://superdesign.dev/blog/fix-generic-ai-landing-page)).

A Node script over built HTML text nodes can enforce four checks:

1. A word-boundary ban list that fails on any hit in headings and CTAs.
2. Regexes for the structures above, plus `\p{Extended_Pictographic}` in `h1`–`h3`, nav and buttons.
3. Density warnings for em dashes. The thresholds are judgment calls; no source validates a number.
4. A "competitor swap" LLM check: if a headline would stay true with a rival's name in it, rewrite it.

The positive rule comes from Anthropic: "Being specific is always better than being clever." The truth rule comes from Framework B itself: **no invented testimonials, logos, counts or stats**. Every number on a page traces to an owner-supplied source.

## Site shape follows the traffic source: landing, full site, or hybrid

The deciding variable is where visitors come from. Paid and QR traffic wants a dedicated single-goal page. Google's Quality Score rates landing-page experience against the ad ([Google Ads Help](https://support.google.com/google-ads/answer/6167118?hl=en)) and counts "the number of links on the page" as a factor ([Search Ads 360](https://support.google.com/sa360/answer/9351020?hl=en)). Unbounce data, via a secondary source, shows **13.5% conversion with one link versus 10.5% with five or more** ([ZoomInfo citing Unbounce](https://pipeline.zoominfo.com/marketing/landing-page-conversion-rates)). Unbounce's own Q4 2024 dataset of 41,000 pages puts the median landing page at **6.6%** ([Unbounce](https://unbounce.com/average-conversion-rates-landing-pages)).

Organic search needs real URLs. Google ignores `#fragment` sections for indexing ([Google Search Central](https://developers.google.com/search/docs/specialty/ecommerce/designing-a-url-structure-for-ecommerce-sites)). One page can target only a small cluster of keywords ([Ahrefs](https://ahrefs.com/blog/single-page-website)). Near-duplicate city pages count as doorway spam ([Google spam policies](https://developers.google.com/search/docs/essentials/spam-policies)).

| Shape | Choose when | Page set | Chrome |
|---|---|---|---|
| Landing only | Idea validation or waitlist; one offer, audience and CTA; traffic is paid, email, social or QR; time-boxed campaign | `/` or `/waitlist`, `/privacy`, `/terms`, thank-you | No or minimal nav, one CTA, minimal footer |
| Full site | Organic search matters; 2+ services or audiences; local service business; high-consideration purchase | Home, Services (one URL each once there are 2+), About, Contact, FAQ, Privacy, Terms; add Pricing, Reviews, Blog and real-location pages as earned | Global nav, fat footer, indexable |
| Hybrid (default for most small businesses) | Any ad spend or printed QR codes plus a need for trust and SEO | 5–7 page core plus `/lp/<campaign>` pages that mirror each ad, optionally noindexed | Two templates sharing one section library and one token file |

Fake-door validation is honest when the page says "coming soon" and never charges for something that doesn't exist ([Exponentially](https://www.exponentially.com/fake-door-test)). Email capture is a stronger intent signal than clicks ([User Intuition](https://www.userintuition.ai/reference-guides/fake-door-testing-validate-demand-zero-code)). Practitioner thresholds such as a 10–15% targeted CTR are heuristics, so the agent should derive pass/fail from the owner's economics before launch ([Swetrix](https://swetrix.com/blog/fake-door-test)).

Growth without a redesign is an architecture choice, not a research finding. Every page is assembled from the same token-driven sections, so "promote FAQ to `/faq`" means adding a route, not reskinning. Put a landing page at `/` only if it will become the home page. Printed and ad entry URLs stay alive forever; only their destination changes.

### Conversion structure and form design

The landing stack is hero (headline mirroring the ad or QR promise, one-sentence subhead, CTA or short form visible on the first mobile screen), value or how-it-works, proof, objections and FAQ, repeated CTA, minimal footer. Unbounce data via a secondary source shows **copy at a 5th–7th-grade reading level converting at 11.1% versus 5.3%** for professional-level copy, and mobile bringing about 5× more traffic but converting about 8% lower ([Hartzer](https://www.hartzer.com/blog/unbounce-2024-conversion-benchmark-report/)).

Forms should ask only for fields the owner will use. Removal also needs judgment: CXL documents a cut from nine fields to six that dropped conversion 14% ([CXL](https://cxl.com/blog/reduce-form-fields/)). Use single-step forms for two to five fields. The largest dataset, 329M popup impressions, showed single-step and multi-step **effectively tied at 3.81% versus 3.75%** ([Novotny](https://www.milan-novotny.com/statistics/multi-step-vs-single-step-form-statistics)). Reserve multi-step for quote and qualification forms over five or six fields. Validate on blur and keep erroneous input with a specific message ([NN/g](https://www.nngroup.com/articles/web-form-design/)). Label optional fields and explain why a phone number is required ([Baymard](https://baymard.com/research-articles/current-state-of-checkout-ux)).

**All Framework B forms are auto opt-in by owner decision, so the design layer has no consent checkbox by default.** What the design does need is honesty and exit. The privacy page and the confirmation email say plainly that submitting subscribes the address, and every marketing email carries the unsubscribe link. US CAN-SPAM requires no prior consent but does require a working opt-out honored within 10 business days and a valid postal address ([FTC](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)). The caveat is regional. Canada's CASL and the EU's GDPR expect affirmative opt-in with no pre-ticked boxes ([InboxArmy](https://www.inboxarmy.com/blog/email-marketing-laws-every-marketer-needs-to-know-in-2026); [Migomail](https://www.migomail.com/blog/post/gdpr-email-marketing-compliance)). A site aimed at those audiences needs a legal review and possibly a regional variant, as a deliberate exception.

## Industry suggestions are starting points the owner can overrule

The only research-grade rule across industries is to match the design to "the tone and personality of your audience" ([NN/g About Us report](https://media.nngroup.com/media/reports/free/Presenting_Company_Information_on_Corporate_Websites_3rd_Edition.pdf)). Trust comes from specific, checkable details: who does the work and photos of the process ([NN/g](https://www.nngroup.com/articles/trustworthy-design)), external reviews, and prices or time windows shown up front.

Trades guidance from marketing agencies is consistent: keep the phone visible, put license and insurance near the call button, and use real crew photos ([Trades Lead Engine](https://tradesleadengine.com/services/contractor-website-design)). Those agencies have a commercial interest, though, and their statistics weren't traced to primary sources. The agent should present the table below as "I'd suggest X because Y. Keep it or pick another?" It is never a mandate, and the owner's tile pick always wins.

| Industry | Suggested starting styles | Trust signals to include | Suggest avoiding |
|---|---|---|---|
| Local services / trades | Swiss-clean or warm practical, high contrast | Tap-to-call header + sticky mobile call bar, license/insurance near CTA, rating linking out, service area, real crew photos | Luxury whitespace that hides the phone; stock models; carousels |
| Professional services | Editorial or Swiss | Named people with credentials, clear fees and process | Neo-brutalism, playful illustration, dark-only |
| Health / wellness | Warm organic or calm clinical; hyperlegible body | Credentials, insurance accepted, booking path, real clinic photos | Neon, dense motion, unverified claims |
| Creative / arts / media | Editorial, Swiss, or retro/brutalist by genre | Work samples first, credits, press, the people behind the work | SaaS-template look; autoplay video with sound |
| SaaS / tech | Technical or bento | Real screenshots, real customer quotes, transparent pricing | AI purple, fake logos, glow blobs, competing CTAs |
| Food / hospitality | Warm organic, editorial or playful | HTML menu (not PDF), hours, map, reservations, real food photos | Text over busy photos |
| Nonprofit / community | Warm organic or editorial with human photography | Specific impact numbers, stories, financial transparency ([NN/g](https://www.nngroup.com/articles/corporate-social-responsibility)) | Corporate coldness, vague claims |
| Idea validation / waitlist | Neo-brutalist, technical or editorial by audience | Specific problem, named founder, honest "early" framing | Fabricated traction, testimonials or logos |

## An eight-step intake turns owner reactions into a locked DESIGN.md

Mainstream AI builders skip preference capture. Wix asks four to five business questions, then offers "Generate new theme" and "Shuffle these colors" loops ([WebsiteBuilderExpert](https://www.websitebuilderexpert.com/website-builders/how-use-wix-ai/)). Durable asks three ([Dupple](https://dupple.com/learn/best-ai-website-builders)). The documented result is "recognizably Wix-shaped" output. Agencies close that gap with adjectives, references *with reasons*, paired-opposite sliders and per-dimension multiple choice ([ReallyGoodDesigns](https://reallygooddesigns.com/website-design-questionnaire-free-template/); [Miro](https://miro.com/templates/brand-personality-sliders/)).

Agencies then use **style tiles**: type, color and UI-element samples that sit between a vague mood board and a full comp. Full comps give a "false sense of completion," and showing several invites a mix-and-match "Frankencomp" ([A List Apart](https://alistapart.com/article/style-tiles-and-how-they-work/)). Rendered samples work because visual appeal is judged consistently within **50 ms** (Lindgaard 2006, via secondary summary) ([WebsiteOptimization](https://old.websiteoptimization.com/speed/tweak/blink)).

Option counts follow the choice-overload evidence. The Chernev et al. meta-analysis (99 observations, N = 7,202) found overload grows with choice-set complexity, task difficulty, preference uncertainty and an effort-minimizing goal ([Kellogg](https://www.kellogg.northwestern.edu/faculty/research/detail/2015/when-product-assortment-leads-to-choice-overload-a-conceptual)). All four describe a non-designer choosing a look. So the intake shows **two options per element pair and three per tile set**, with one combine round.

"I don't know" is handled the way Impeccable's `init` handles everything. The agent reads the project and asks the owner to *confirm* inferred answers rather than author them ([Impeccable init](https://www.impeccable.style/docs/init)). Each question arrives pre-filled with a reasoned default, and any default the owner leaves in place is recorded as `inferred`.

The capture format is settled. Google Labs' **DESIGN.md** (Apache-2.0, version "alpha") puts normative YAML tokens (colors, typography, rounded, spacing, components; at least `primary`) in front matter. The prose follows in eight ordered sections: Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts. `npx @google/design.md lint` checks token references and WCAG contrast, and `diff` reports token regressions. Duplicate sections or keys reject the file ([spec](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md); [README](https://github.com/google-labs-code/design.md)). Impeccable's `document` writes this format and puts product context in a separate `PRODUCT.md` ([Impeccable document](https://www.impeccable.style/docs/document)). For downstream tools, W3C DTCG Format 2025.10 became the first stable token spec on 2025-10-28 ([W3C DTCG](https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/)). The spec is alpha, so pin the CLI.

The visual-choice steps need nowhere new to live. Workers Builds branch previews are automatically noindexed ([Workers Previews](https://developers.cloudflare.com/workers/previews/)), and Framework B already puts them behind Cloudflare Access. The agent pushes a `design/intake` branch with the pair pages and tiles, then sends the owner the link, or screenshots when the chat surface shows images. The owner replies in chat ("B, with the type from A"). No form backend is required.

## Deterministic gates run first, then at most three critique rounds

Two kinds of check need two stop rules. **Hard gates are binary and can't oscillate**, so they loop until green, with five fix attempts before escalating to the owner. The free headless stack:

1. **Playwright** (`@playwright/test` 1.64.1) captures full-page screenshots at 360, 768, 1280 and 1920 px. In the same pass it asserts no horizontal scroll and no console errors, and runs computed-style checks for banned fonts, high-saturation 250–290° hues and gradient text.
2. **`@axe-core/playwright` 4.14.0** checks WCAG 2.1 AA. Automated testing "cannot detect all types of WCAG violations" ([Playwright](https://playwright.dev/docs/accessibility-testing)).
3. **Lighthouse CI** (`@lhci/cli` 0.15.1) uses `staticDistDir` against Astro's `dist/`, filesystem upload and three runs ([LHCI](https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md)).
4. **`impeccable detect`** runs against both source and the preview URL.
5. **Stylelint** enforces tokens, and **`@google/design.md lint`** checks the token file.

This QA stack supersedes the earlier 375/1440 px plan.

The soft layer is a vision-model critique, and it is the least reliable part. Against 9,296 crowd ratings, GPT-4o, Claude 3.5 Sonnet and Llama-3.2-Vision correlated with humans at **r ≈ 0.69–0.73**. They were strong on clarity, hierarchy and trust, weak on ease of use and aesthetic pleasure. Their pairwise agreement rose only as the true quality gap widened ([arXiv 2510.08783](https://arxiv.org/html/2510.08783v1)). Those are 2024-era models, and no newer comparison was found.

Critique still pays when it is bounded. A VLM visual critic improved frontend output **by up to 17.8% over three refinement cycles** ([arXiv 2604.05839](https://arxiv.org/abs/2604.05839)). ReLook keeps a loop from degrading by accepting only revisions that beat the previous version and giving broken renders zero credit ([ReLook](https://preview.aclanthology.org/ingest-acl/2026.acl-long.1167/)).

The contract that follows:

- **Rubric.** Five 1–5 dimensions: hierarchy and clarity; subject-specificity ("could this belong to another business?"); count of named tells; consistency with DESIGN.md; trust.
- **Fixes.** At most three located fixes per round.
- **Acceptance.** A pairwise judge compares old and new screenshots twice, with sides swapped. A revision is accepted only if it wins both orders; otherwise it is reverted.
- **Stop.** The loop ends when every dimension is ≥4 with ≤1 tell, when a round produces no accepted revision, after three rounds, or when any hard gate regresses.
- **Lock.** Owner approval locks `toHaveScreenshot` baselines, generated in the same container image as CI because rendering varies by host ([Playwright snapshots](https://playwright.dev/docs/test-snapshots)).

The three-round cap has evidence behind it. The ≥4 threshold and the use of a different model family as judge are design choices without published support.

## Proposed P2: the design phase, step by step

P2 sits between P1 (repo) and P3 (build) in the existing pipeline. It ends when `DESIGN.md` is locked. Its QA contract then runs at the end of P3 and again at P6 staging, before the owner approves the preview. Every step has a default, so a one-prompt build never blocks. In autopilot mode the agent picks the tile with the best rubric score and marks every choice `inferred` in `DECISIONS.md`.

### Steps

| Step | Agent does | Owner does | Output | Default if owner is silent |
|---|---|---|---|---|
| P2.0 Infer | Reads prompt, existing site, logo, copy, config; runs `/impeccable init`; drafts PRODUCT.md with `inferred` flags | Nothing | `PRODUCT.md` draft | — |
| P2.1 Confirm + shape | Asks 4–6 confirm-or-correct questions (offer, audience, the one action, differentiator, 2–3 competitors, assets and must-keeps, content readiness); proposes landing/full/hybrid using the traffic-source rule | Confirms or corrects in chat | `PRODUCT.md`; `design/sitemap.md` (pages, template per page, section order) | Hybrid when ads or QR are planned; landing for idea validation; full site for local services |
| P2.2 Personality | Metaphor prompt; 5–6 sliders with defaults (classic↔modern, playful↔serious, warm↔cool, minimal↔rich, quiet↔bold, approachable↔exclusive); reflects back a one-sentence brand vision | Moves sliders or accepts; confirms the vision | Adjectives and slider values in `PRODUCT.md` | Industry-derived slider positions |
| P2.3 References | Asks for 2–3 loved sites and 1–2 disliked, each with why; offers 4–6 agent-picked sites (some outside the industry) for thumbs up/down if none | Gives URLs + reasons, or thumbs | References and anti-references in `PRODUCT.md` | No references; rely on style menu |
| P2.4 Suggest styles | Proposes 3 named styles from the menu with industry rationale, phrased as suggestions; shows the pre-checked avoid list (owner may unban) | Keeps or swaps a style; edits avoid list | Shortlist + avoid list in `PRODUCT.md` | Top 3 by industry table |
| P2.5 This-or-that | Renders 4–6 two-option pairs on the owner's real headline (display type, palette, imagery mode, density, shape language) on the preview branch | Picks A or B per pair | Picks in `design/intake.json` | Agent's recommended side |
| P2.6 Tiles | Writes 3 DESIGN.md drafts (frontend-design token plan + anti-default self-review), lints each, renders each as an HTML style tile with real copy | Picks one or combines at tile level | `design/tiles/{a,b,c}.html` | Highest pairwise-ranked tile |
| P2.7 Check + refine | Five-word check from ~20 mixed-valence adjectives; one refine round if the check misses the P2.2 adjectives; at most one "shuffle" round | Picks five words; reviews refine | Updated draft | Skip check |
| P2.8 Lock | Finalizes DESIGN.md, generates tokens, writes image plan and credits ledger, appends design rules to AGENTS.md, commits | Nothing (taste changes move to post-build revisions) | Files below | — |

### Files produced

| File | Contents | Produced by |
|---|---|---|
| `PRODUCT.md` | Users, Purpose, Constraints, Evidence on hand (Impeccable headings), plus primary action, site shape, adjectives, slider values, references with reasons, anti-references, content readiness; every default marked `inferred` | `/impeccable init`, then agent edits |
| `DESIGN.md` | Google format: YAML tokens (colors with descriptive names, 9–15 typography levels, rounded, spacing, components and hover variants); the eight sections in order; brand vision and chosen tile in Overview; avoid list and any deliberate trap choices in Do's and Don'ts; `omitted:` with reasons | Agent + `/impeccable document`, linted |
| `src/styles/tokens.css` | Tailwind 4 `@theme` block generated from DESIGN.md, default palette reset, OKLCH scales | `scripts/design-tokens.mjs` |
| `tokens.json` (optional) | DTCG 2025.10 export, only if a downstream tool needs it | Same script |
| `.impeccable/design.json` (optional) | Motion and other metadata Markdown can't express | `/impeccable document` |
| `design/sitemap.md` | Shape decision, page list, template per page, section order per page with the argument it serves | Agent |
| `design/intake.json`, `design/tiles/*.html` | Raw picks, five-word result, all three tiles; approved tile kept for reference on previews only, never in the production build | Agent |
| `design/images.md` + `src/content/credits.json` | Source of every image (owner, Openverse with license and creator, manual stock download, Workers AI abstract), alt text, credit line | Agent |
| `AGENTS.md` design section | Ban list, copy rules, "no fabricated people or proof," Vercel guidelines pointer, gate commands | Agent (template) |
| `.stylelintrc.json`, `lighthouserc.json`, `scripts/copy-lint.mjs`, `scripts/visual-qa.ts`, `tests/visual.spec.ts` | Gate configs; baselines in `tests/__screenshots__` after owner approval | Template |
| `qa/` | Screenshots per width, axe JSON, Impeccable JSON, LHCI reports, `critique-round-N.md` | Gate runs |

### Tools chosen, with versions

| Role | Tool | Version / license | Cost | Notes |
|---|---|---|---|---|
| Framework / CSS | Astro, Tailwind CSS | 7.4.2 (MIT); 4.3.3 (MIT) ([npm](https://registry.npmjs.org/astro); [npm](https://registry.npmjs.org/tailwindcss)) | Free | Pin both |
| Process skill | Anthropic frontend-design | Apache-2.0, vendored `SKILL.md` | Free | Token plan + anti-default review |
| Design commands + detector | Impeccable | 4.7.0, Apache-2.0 | Free | Pin; vendor `IMPECCABLE_BIN` |
| Review rules | Vercel web-design-guidelines | Live rules | Free | As AGENTS.md section or skill |
| Format + lint | `@google/design.md` CLI | Alpha; pin at adoption (version not captured in this research) | Free | `lint`, `diff` |
| Palette | Owner logo → Huemint API → local OKLCH scale | Keyless API; scale library version to verify | Free | tints.dev dropped (bot challenge) |
| Fonts / icons | Astro Fonts API + Fontsource; astro-icon + `@iconify/json` | Built in; 2.2.546 MIT | Free | 2 families, ~4 files |
| Components | Starwind UI; accessible-astro-components | 3.4.0 MIT; 5.8.1 MIT | Free | Smoke-test Starwind on Astro 7 |
| Images | Openverse API; Workers AI `flux-1-schnell` | Keyless; 10k neurons/day free | Free | Abstract-only generation |
| Rendered QA | `@playwright/test`; `@axe-core/playwright`; `@lhci/cli` | 1.64.1; 4.14.0; 0.15.1 | Free | Run in the cloud container or CI with Chromium |
| Source QA | `stylelint-declaration-strict-value`; `stylelint-plugin-defensive-css`; `apca-w3` (advisory) | 1.12.1; 2.9.7; 0.1.9 | Free | APCA as a warning, WCAG as the gate |
| Optional inputs | Stitch SDK; Framelink Figma MCP; Refero MCP | 0.3.5 Apache-2.0; 0.13.2 MIT; paid | Free / free / paid | Only if the owner has a file or opts into paid references |

### Gates

| Gate | Pass condition | On fail |
|---|---|---|
| G1 Intake complete | Every PRODUCT.md field filled or marked `inferred`; site shape recorded | Apply defaults, log to DECISIONS.md |
| G2 Token plan review | Written diff showing the plan was checked against the banned clusters (purple/indigo, cyan-on-dark, cream + serif + terracotta, near-black + acid accent, broadsheet hairlines, reflex Inter/Geist/Space Grotesk/Instrument Serif) | Revise once, stating what changed |
| G3 DESIGN.md lint | `design.md lint` returns no errors (references, contrast, structure) | Fix tokens |
| G4 Source gates | Stylelint strict-value clean; `impeccable detect --json src/` exit 0 (rules listed as deliberate in DESIGN.md handled as warnings by the wrapper script); copy lint clean | Fix; max 5 attempts, then escalate |
| G5 Render gates | At 360/768/1280/1920: no horizontal scroll, no console errors, computed-style checks pass; axe 0 serious/critical; `impeccable detect <preview-url>` exit 0; LHCI accessibility, SEO and best practices = 1.0, performance ≥ 0.95, CLS ≤ 0.1 | Fix; max 5 attempts, then escalate |
| G6 Truth gate | No testimonial, logo, statistic or face lacks an owner source or credits entry; existing pre-launch content check passes | Remove the element |
| G7 Soft critique | Rubric ≥4 on all five dimensions with ≤1 tell, or stop at 3 rounds / no accepted revision | Hand remaining critique and screenshots to the owner |
| G8 Owner approval | Owner approves the Access-gated preview | Revisions become post-build tasks; on approval, lock screenshot baselines |

The LHCI performance threshold of 0.95 allows for run-to-run variance. The other thresholds follow the 100-score result reached on the earlier production build, and all of them are framework choices rather than sourced standards. The Impeccable "warning" wrapper is a small script over its JSON output. Impeccable doesn't document a native per-rule waiver.

### What the owner is asked to do

In one sitting the owner confirms or corrects the business facts (P2.1), nudges sliders and approves a one-line brand vision (P2.2), names a few sites with reasons or thumbs a few offered ones (P2.3), keeps or swaps the suggested styles and avoid list (P2.4), picks one side of four to six pairs (P2.5), picks or combines one of three tiles (P2.6), and picks five words (P2.7). Later the owner approves the staging preview (G8). They also supply real photos of people, premises and work if they want any shown, since the agent will not generate them. Their visitors' region matters too: auto opt-in suits US audiences, but Canadian or EU audiences trigger a legal check. Nothing gets installed on the owner's machine. Every link the owner opens is a noindexed, Access-gated preview, and every answer can be a one-word chat reply.

## Conclusion

AI design quality is now mostly a governance problem, not a generation problem. The models can render any named style competently. What they lack is a binding, subject-specific contract and an independent check that the rendered page honors it. That shifts where an agent framework should spend its effort. The cheapest high-leverage pieces are a file format (DESIGN.md), a detector that reads it (Impeccable), and an intake that asks owners to react rather than describe. A cleverer prompt or a bigger component library adds less.

The more surprising finding is that "anti-slop" is a moving target that styles can walk into on their own. Warm organic, editorial and technical, the three styles most small businesses will pick, are each one default rendition away from a known AI cluster. A framework that bans looks will keep chasing the next default. One that requires every visual choice to trace to the owner's picks, references and subject, and records deliberate exceptions instead of forbidding them, stays distinctive as the defaults shift.

Two things remain unproven: whether vision judges built on current models beat the 2024-era correlations, and whether the owner-time estimate holds in practice. Both should be measured on the next live build rather than assumed.
