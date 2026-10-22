-- Framework B core schema. One schema for both modes: idea sites share a database and are
-- separated by the site column; launch sites have their own database with a single site value.
-- D1 is the system of record. Never delete or rewrite rows without the owner's approval.

CREATE TABLE IF NOT EXISTS leads (
  id               TEXT PRIMARY KEY,
  site             TEXT NOT NULL,
  form             TEXT NOT NULL,
  email            TEXT NOT NULL,
  name             TEXT,
  phone            TEXT,
  message          TEXT,
  fields_json      TEXT NOT NULL DEFAULT '{}',
  consent_text     TEXT NOT NULL,
  page             TEXT,
  attribution_json TEXT NOT NULL DEFAULT '{}',
  upload_key       TEXT,
  upload_name      TEXT,
  upload_type      TEXT,
  upload_size      INTEGER,
  upload_status    TEXT CHECK (upload_status IN ('pending', 'uploading', 'stored', 'failed')),
  notified         INTEGER NOT NULL DEFAULT 0,
  notify_error     TEXT,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  confirm_error    TEXT,
  country          TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leads_site_created ON leads (site, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_site_form_created ON leads (site, form, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_site_email ON leads (site, email);

CREATE TABLE IF NOT EXISTS subscribers (
  site            TEXT NOT NULL,
  email           TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('subscribed', 'unsubscribed')),
  source_form     TEXT,
  consent_text    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  unsubscribed_at TEXT,
  PRIMARY KEY (site, email)
);
