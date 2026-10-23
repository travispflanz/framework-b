#!/usr/bin/env node
// Re-runs the Workers Builds step for an existing site (for when create.mjs could not connect it).
// Inputs (environment): SITE_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CF_BUILDS_TOKEN, GH_SITES_TOKEN.
import { cf, gh, env, log } from "./lib/api.mjs";
import { connectBuilds } from "./lib/builds.mjs";

const A = `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}`;
const id = env("SITE_ID").trim().toLowerCase();
const tag = (await cf(`${A}/workers/scripts`)).find((s) => s.id === id)?.tag;
if (!tag) throw new Error(`Worker ${id} not found`);
const ghUser = await gh("/user");
const repo = await gh(`/repos/${ghUser.login}/site-${id}`);
const r = await connectBuilds({ A, tag, ghUser, repo });
log("workers builds", r.already ? `already connected (${r.triggers} triggers)` : "production and preview triggers connected");
