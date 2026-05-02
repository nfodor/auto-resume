import Database from 'better-sqlite3'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PATH = join(__dirname, '..', 'data', 'slugs.db')
const DATA_DIR = join(__dirname, '..', 'data')
const SESSIONS_PATH = join(DATA_DIR, 'sessions.json')

mkdirSync(DATA_DIR, { recursive: true })

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
        created_at TEXT DEFAULT (datetime('now')),
        session_id TEXT DEFAULT 'default'
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
    // Migrations
    try { db.exec('ALTER TABLE slugs ADD COLUMN status TEXT DEFAULT "pending"') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN from_name TEXT') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN linkedin_url TEXT') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN body_preview TEXT') } catch {}
    try { db.exec('ALTER TABLE slugs ADD COLUMN session_id TEXT DEFAULT "default"') } catch {}
  }
  return db
}

// ── Session management ───────────────────────────────────────────

function loadSessions() {
  if (!existsSync(SESSIONS_PATH)) {
    const initial = { active: 'default', sessions: { default: { id: 'default', label: 'Initial', created: new Date().toISOString(), importDays: 0 } } }
    writeFileSync(SESSIONS_PATH, JSON.stringify(initial, null, 2))
    return initial
  }
  return JSON.parse(readFileSync(SESSIONS_PATH, 'utf-8'))
}

function saveSessions(data) {
  writeFileSync(SESSIONS_PATH, JSON.stringify(data, null, 2))
}

export function getActiveSession() {
  const s = loadSessions()
  return { id: s.active, ...s.sessions[s.active] }
}

export function listSessions() {
  const s = loadSessions()
  return Object.values(s.sessions).sort((a, b) => (b.created || '').localeCompare(a.created || ''))
}

export function switchSession(id) {
  const s = loadSessions()
  if (!s.sessions[id]) return false
  s.active = id
  saveSessions(s)
  return true
}

export function createSession(days = 0) {
  const s = loadSessions()
  const id = `s${Date.now()}`
  const label = days > 0 ? `Import ${days}d` : `Session ${Object.keys(s.sessions).length + 1}`
  s.sessions[id] = { id, label, created: new Date().toISOString(), importDays: days }
  s.active = id
  saveSessions(s)
  return s.sessions[id]
}

// ── Slug operations (session-scoped) ─────────────────────────────

export function createSlug({ slug, email, profile, subject, fromName, trust, tier, flags, linkedinUrl, status, bodyPreview }) {
  const d = getDb()
  const sessionId = getActiveSession().id
  d.prepare(`
    INSERT OR REPLACE INTO slugs (slug, email, profile, subject, from_name, trust_score, trust_tier, flags, linkedin_url, body_preview, status, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(slug, email, profile, subject || '', fromName || '', trust, tier, JSON.stringify(flags), linkedinUrl || null, bodyPreview || null, status || 'pending', sessionId)
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

export function deleteAll() {
  const d = getDb()
  d.prepare('DELETE FROM visits').run()
  d.prepare('DELETE FROM slugs').run()
}

export function clearSession() {
  const d = getDb()
  const sessionId = getActiveSession().id
  d.prepare('DELETE FROM visits WHERE slug IN (SELECT slug FROM slugs WHERE session_id = ?)').run(sessionId)
  d.prepare('DELETE FROM slugs WHERE session_id = ?').run(sessionId)
}

export function getAllStats() {
  const d = getDb()
  const sessionId = getActiveSession().id
  return d.prepare(`
    SELECT s.*, COUNT(v.id) as visits
    FROM slugs s
    LEFT JOIN visits v ON v.slug = s.slug
    WHERE s.session_id = ?
    GROUP BY s.slug
    ORDER BY s.created_at DESC
  `).all(sessionId)
}

export function getPending() {
  const d = getDb()
  const sessionId = getActiveSession().id
  return d.prepare(`
    SELECT s.*, COUNT(v.id) as visits
    FROM slugs s
    LEFT JOIN visits v ON v.slug = s.slug
    WHERE s.status = 'pending' AND s.session_id = ?
    GROUP BY s.slug
    ORDER BY s.created_at DESC
  `).all(sessionId)
}

export function emailAlreadyProcessed(email) {
  const d = getDb()
  const sessionId = getActiveSession().id
  const row = d.prepare("SELECT COUNT(*) as c FROM slugs WHERE email = ? AND session_id = ? AND created_at > datetime('now', '-30 days')").get(email, sessionId)
  return row?.c > 0
}
