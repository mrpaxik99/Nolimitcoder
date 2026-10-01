import { neon } from '@neondatabase/serverless';

let _sql = null;
let schemaReady = false;

export function db() {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set (Vercel → Environment Variables)');
    _sql = neon(url);
  }
  return _sql;
}

// Idempotentní schéma — stačí spustit jednou, bezpečně se volá opakovaně.
export async function ensureSchema() {
  if (schemaReady) return;
  const sql = db();
  await sql`CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    picture TEXT DEFAULT '',
    first_seen TIMESTAMPTZ DEFAULT NOW(),
    last_seen TIMESTAMPTZ DEFAULT NOW(),
    plan TEXT DEFAULT 'free',
    plan_status TEXT DEFAULT 'none',
    total_paid_cents BIGINT DEFAULT 0
  )`;
  await sql`CREATE TABLE IF NOT EXISTS visits (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ DEFAULT NOW(),
    email TEXT DEFAULT NULL,
    path TEXT DEFAULT ''
  )`;
  await sql`CREATE INDEX IF NOT EXISTS visits_ts_idx ON visits (ts DESC)`;
  await sql`CREATE TABLE IF NOT EXISTS presence (
    email TEXT PRIMARY KEY,
    name TEXT DEFAULT '',
    last_seen TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS orders (
    id BIGSERIAL PRIMARY KEY,
    email TEXT DEFAULT '',
    amount_cents BIGINT DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    status TEXT DEFAULT 'pending',
    note TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS app_versions (
    version TEXT PRIMARY KEY,
    download_url TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    is_latest BOOLEAN DEFAULT FALSE,
    released_at TIMESTAMPTZ DEFAULT NOW()
  )`;
  await sql`ALTER TABLE app_versions ADD COLUMN IF NOT EXISTS size_bytes BIGINT DEFAULT 0`;
  schemaReady = true;
}

export function markSchemaStale(e) {
  if (e && (e.code === '42P01' || /does not exist/i.test(e.message || ''))) {
    schemaReady = false;
    return true;
  }
  return false;
}
