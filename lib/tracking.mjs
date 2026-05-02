import Database from 'better-sqlite3'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', 'data', 'slugs.db')

let db

function getDb() {
  if (!db) {
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS slugs (
        slug TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        profile TEXT NOT NULL,
        subject TEXT,
        from_name TEXT,
        trust_score INTEGER DEFAULT 0,
        trust_tier TEXT DEFAULT 'unverified',
        flags TEXT DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        linkedin_url TEXT,
        body_preview TEXT,
        reply_sent INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        timestamp TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (slug) REFERENCES slugs(slug)
      )
    `)
    // Add columns if they don't exist (migration)
    try { db.exec('ALTER TABLE slugs ADD COLUMN status TEXT DEFAULT "pending"') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN from_name TEXT') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN linkedin_url TEXT') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN body_preview TEXT') } catch {}
  }
  return db
}

export function createSlug({ slug, email, profile, subject, fromName, trust, tier, flags, linkedinUrl, status, bodyPreview }) {
  const d = getDb()
  d.prepare(`
    INSERT OR REPLACE INTO slugs (slug, email, profile, subject, from_name, trust_score, trust_tier, flags, linkedin_url, body_preview, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, email, profile, subject || '', fromName || '', trust, tier, JSON.stringify(flags), linkedinUrl || null, bodyPreview || null, status || 'pending')
}

export function logVisit(slug, ip, userAgent) {
  const d = getDb()
  d.prepare('INSERT INTO visits (slug, ip, user_agent) VALUES (?, ?, ?)')
    .run(slug, ip?.split(',')[0]?.trim() || '', userAgent || '')
}

export function getSlug(slug) {
  const d = getDb()
  return d.prepare('SELECT * FROM slugs WHERE slug = ?').get(slug)
}

export function updateStatus(slug, status) {
  const d = getDb()
  d.prepare('UPDATE slugs SET status = ? WHERE slug = ?').run(status, slug)
}

export function updateTrust(slug, trustDelta, tier, flags) {
  const d = getDb()
  d.prepare('UPDATE slugs SET trust_score = trust_score + ?, trust_tier = ?, flags = ? WHERE slug = ?')
    .run(trustDelta, tier, flags, slug)
}

export function deleteSlug(slug) {
  const d = getDb()
  d.prepare('DELETE FROM visits WHERE slug = ?').run(slug)
  d.prepare('DELETE FROM slugs WHERE slug = ?').run(slug)
}

export function getAllStats() {
  const d = getDb()
  return d.prepare(`
    SELECT s.*, COUNT(v.id) as visits
    FROM slugs s
    LEFT JOIN visits v ON v.slug = s.slug
    GROUP BY s.slug
    ORDER BY s.created_at DESC
  `).all()
}

export function getPending() {
  const d = getDb()
  return d.prepare(`
    SELECT s.*, COUNT(v.id) as visits
    FROM slugs s
    LEFT JOIN visits v ON v.slug = s.slug
    WHERE s.status = 'pending'
    GROUP BY s.slug
    ORDER BY s.created_at DESC
  `).all()
}

export function emailAlreadyProcessed(email) {
  const d = getDb()
  const row = d.prepare("SELECT COUNT(*) as c FROM slugs WHERE email = ? AND created_at > datetime('now', '-30 days')").get(email)
  return row?.c > 0
}
