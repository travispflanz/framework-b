// POST /api/submit/:form  and  PUT /api/upload/:leadId
//
// Submit: origin check → size cap → rate limit → honeypot → Turnstile → schema validation →
// one D1 batch (lead row + subscriber upsert; auto opt-in) → mail in waitUntil.
// If the form has a file field and the visitor chose a file, the response carries a signed,
// single-use upload URL. The browser then PUTs the file body to it, and the Worker streams it to R2.
// Turnstile is checked once, before any upload ticket exists (upload safeguard 1).

import { verifyTurnstile } from "./lib/turnstile.js";
import { sign, verify } from "./lib/crypto.js";
import { EMAIL_RE, clip, json, safeFileName } from "./lib/util.js";
import { deliver } from "./mailers.js";
import { crmRow, mirror } from "./crm.js";
import { startDrip } from "./drips.js";

const MAX_BODY_BYTES = 64 * 1024;
const UPLOAD_TICKET_SECONDS = 15 * 60;
const ATTR_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "src", "ref", "referrer", "landing"];

function sameOrigin(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === url.host;
  } catch {
    return false;
  }
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    const obj = Object.fromEntries(form);
    return JSON.stringify(obj).length > MAX_BODY_BYTES ? null : obj;
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text);
      return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
    } catch {
      return null;
    }
  }
  return null;
}

function validateFields(form, body) {
  const values = {};
  const errors = {};
  for (const f of form.fields) {
    let v = body[f.name];
    if (f.type === "checkbox") {
      values[f.name] = v === true || v === "on" || v === "true" || v === "1" ? "yes" : "";
    } else {
      v = typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
      if (v.length > f.maxLength) errors[f.name] = "too_long";
      if (f.type === "email") v = v.toLowerCase();
      if (v && f.type === "email" && (v.length > 254 || !EMAIL_RE.test(v))) errors[f.name] = "invalid_email";
      if (v && f.type === "url" && !/^https?:\/\/\S+$/i.test(v)) errors[f.name] = "invalid_url";
      if (v && f.type === "tel" && !/^[+()\d\s.\-]{5,30}$/.test(v)) errors[f.name] = "invalid_phone";
      if (v && f.type === "select" && !f.options.some((o) => (o.value ?? o) === v)) errors[f.name] = "invalid_option";
      values[f.name] = v;
    }
    if (f.required && !values[f.name]) errors[f.name] = errors[f.name] || "required";
  }
  return { values, errors };
}

function attribution(body) {
  const out = {};
  for (const k of ATTR_KEYS) {
    const v = body[`attr_${k}`];
    if (typeof v === "string" && v.trim()) out[k] = clip(v, 300);
  }
  // Referrer and landing page are stored without query strings.
  for (const k of ["referrer", "landing"]) if (out[k]) out[k] = out[k].split("?")[0].split("#")[0];
  return out;
}

function fileRequest(form, body) {
  if (!form.file.enabled || !body.file_name) return { file: null };
  const size = Number(body.file_size);
  const type = String(body.file_type || "").toLowerCase();
  if (!Number.isInteger(size) || size <= 0) return { error: "file_size" };
  if (size > form.file.maxBytes) return { error: "file_too_large" };
  if (!form.file.types.includes(type)) return { error: "file_type" };
  return { file: { name: safeFileName(body.file_name), size, type } };
}

function uploadMessage(site, id, size, type, exp) {
  return `upload:${site}:${id}:${size}:${type}:${exp}`;
}

export async function handleSubmit(request, env, ctx, config, formId) {
  const url = new URL(request.url);
  const form = config.forms[formId];
  if (!form) return json({ ok: false, error: "unknown_form" }, 404);
  if (!sameOrigin(request, url)) return json({ ok: false, error: "origin" }, 403);
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) return json({ ok: false, error: "too_large" }, 413);

  const ip = request.headers.get("cf-connecting-ip") || "";
  if (env.SUBMIT_LIMITER) {
    const { success } = await env.SUBMIT_LIMITER.limit({ key: `${config.site.id}:${ip}` });
    if (!success) return json({ ok: false, error: "rate_limited" }, 429);
  }

  const body = await readBody(request);
  if (!body) return json({ ok: false, error: "bad_body" }, 400);

  // Honeypot: a field humans never see. Pretend success so bots learn nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") return json({ ok: true, redirect: form.thanks });

  const ts = await verifyTurnstile(env, body["cf-turnstile-response"], ip, url.hostname, config.turnstile?.hostnames || []);
  if (!ts.ok) return json({ ok: false, error: ts.reason }, 403);

  const { values, errors } = validateFields(form, body);
  // Checkbox opt-in: the box is the only thing that subscribes. A required box must be ticked to send at all.
  const checkboxMode = config.optIn.mode === "checkbox";
  const ticked = ["on", "yes", "true", "1"].includes(String(body.consent ?? "").toLowerCase()) || body.consent === true;
  if (checkboxMode && form.consent === "required" && !ticked) errors.consent = "required";
  const fileReq = fileRequest(form, body);
  if (fileReq.error) errors.file = fileReq.error;
  if (Object.keys(errors).length) return json({ ok: false, error: "invalid", fields: errors }, 422);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const email = values.email;
  const page = clip(body.page || request.headers.get("referer") || "", 500).split("?")[0];
  const attr = attribution(body);
  const file = fileReq.file;
  const consents = !checkboxMode || ticked;
  // The wording the visitor agreed to, kept on the lead row; empty when a checkbox form was sent without the box.
  const consentText = checkboxMode ? (ticked ? config.optIn.label : "") : config.optIn.text;

  const statements = [
    env.DB.prepare(
      `INSERT INTO leads (id, site, form, email, name, phone, message, fields_json, consent_text, page, attribution_json,
         upload_name, upload_type, upload_size, upload_status, country, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      config.site.id,
      formId,
      email,
      values.name || null,
      values.phone || null,
      values.message || null,
      JSON.stringify(values),
      consentText,
      page || null,
      JSON.stringify(attr),
      file?.name ?? null,
      file?.type ?? null,
      file?.size ?? null,
      file ? "pending" : null,
      request.cf?.country || null,
      now,
    ),
  ];
  // Auto opt-in: every form is a sign-up form, and submitting one subscribes the visitor (re-subscribing someone who
  // unsubscribed earlier: filling in a form that says "you'll get emails" is a new opt-in). Checkbox mode: only a
  // ticked box does that. The lead row keeps the wording agreed to each time, so every opt-in stays on record.
  if (consents) statements.push(
    env.DB.prepare(
      `INSERT INTO subscribers (site, email, status, source_form, consent_text, created_at, updated_at)
       VALUES (?, ?, 'subscribed', ?, ?, ?, ?)
       ON CONFLICT (site, email) DO UPDATE SET status = 'subscribed', source_form = excluded.source_form,
         consent_text = excluded.consent_text, updated_at = excluded.updated_at, unsubscribed_at = NULL`,
    ).bind(config.site.id, email, formId, consentText, now, now),
  );
  await env.DB.batch(statements);

  const lead = { id, email, fields: values, page, upload: file };
  ctx.waitUntil(deliver(env, config, formId, lead, url.origin).catch((e) => console.error("deliver", e)));
  if (config.crm?.sheet || config.crm?.webhook) {
    const row = crmRow(config, { id, form: formId, email, createdAt: now, page, country: request.cf?.country, fields: values, attribution: attr });
    ctx.waitUntil(mirror(env, config, row).catch((e) => console.error("crm mirror", e)));
  }
  if (config.drips && consents) ctx.waitUntil(startDrip(env, config, formId, lead).catch((e) => console.error("drip", e)));

  const res = { ok: true, id, redirect: form.thanks };
  if (file) {
    const exp = Math.floor(Date.now() / 1000) + UPLOAD_TICKET_SECONDS;
    const sig = await sign(env.SIGNING_SECRET, uploadMessage(config.site.id, id, file.size, file.type, exp));
    res.upload = { url: `/api/upload/${id}?exp=${exp}&sig=${sig}`, method: "PUT", headers: { "content-type": file.type } };
  }
  // A plain HTML form post (no JavaScript) gets a normal redirect to the thank-you page.
  if (isPlainFormPost(request)) return Response.redirect(new URL(form.thanks, url).toString(), 303);
  return json(res);
}

function isPlainFormPost(request) {
  const type = request.headers.get("content-type") || "";
  const accept = request.headers.get("accept") || "";
  return type.includes("application/x-www-form-urlencoded") && !accept.includes("application/json");
}

export async function handleUpload(request, env, config, leadId) {
  const url = new URL(request.url);
  if (!env.UPLOADS) return json({ ok: false, error: "uploads_disabled" }, 404);
  if (!sameOrigin(request, url)) return json({ ok: false, error: "origin" }, 403);
  if (!/^[0-9a-f-]{36}$/.test(leadId)) return json({ ok: false, error: "not_found" }, 404);

  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") || "";
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return json({ ok: false, error: "expired" }, 403);

  const row = await env.DB.prepare(
    "SELECT upload_name, upload_type, upload_size, upload_status FROM leads WHERE id = ? AND site = ?",
  ).bind(leadId, config.site.id).first();
  if (!row || row.upload_status !== "pending") return json({ ok: false, error: "not_pending" }, 409);

  const okSig = await verify(env.SIGNING_SECRET, uploadMessage(config.site.id, leadId, row.upload_size, row.upload_type, exp), sig);
  if (!okSig) return json({ ok: false, error: "bad_signature" }, 403);

  // The body must be exactly the size and type that were signed (upload safeguard 2).
  const length = Number(request.headers.get("content-length"));
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (length !== row.upload_size) return json({ ok: false, error: "size_mismatch" }, 400);
  if (type !== row.upload_type) return json({ ok: false, error: "type_mismatch" }, 400);
  if (!request.body) return json({ ok: false, error: "no_body" }, 400);

  // Claim the ticket first so it can't be used twice in parallel.
  const claim = await env.DB.prepare(
    "UPDATE leads SET upload_status = 'uploading' WHERE id = ? AND site = ? AND upload_status = 'pending'",
  ).bind(leadId, config.site.id).run();
  if (!claim.meta?.changes) return json({ ok: false, error: "not_pending" }, 409);

  const key = `${config.site.id}/${leadId}/${row.upload_name}`;
  try {
    // Streams straight to R2 without buffering, which keeps CPU time low (Workers Free allows 10 ms).
    const stream = request.body.pipeThrough(new FixedLengthStream(row.upload_size));
    await env.UPLOADS.put(key, stream, {
      httpMetadata: { contentType: row.upload_type, contentDisposition: `attachment; filename="${row.upload_name}"` },
      customMetadata: { site: config.site.id, lead: leadId },
    });
  } catch (e) {
    await env.DB.prepare("UPDATE leads SET upload_status = 'failed' WHERE id = ?").bind(leadId).run();
    console.error("upload", e);
    return json({ ok: false, error: "upload_failed" }, 500);
  }
  await env.DB.prepare("UPDATE leads SET upload_status = 'stored', upload_key = ? WHERE id = ?").bind(key, leadId).run();
  return json({ ok: true });
}
