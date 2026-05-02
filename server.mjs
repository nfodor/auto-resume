import express from 'express'
import { nanoid } from 'nanoid'
import { writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx'
import matter from 'gray-matter'
import { loadExperiences, filterForProfile } from './lib/experiences.mjs'
import { matchProfile, getProfile, getSkills, getContact, listProfiles } from './lib/profiles.mjs'
import { verifyRecruiter, scoreLinkedInProfile } from './lib/verify.mjs'
import { createSlug, logVisit, getSlug, getAllStats, getPending, updateStatus, deleteSlug, updateTrust, deleteAll, clearSession, emailAlreadyProcessed, getActiveSession, listSessions, createSession, switchSession } from './lib/tracking.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FOLLOWUPS_DIR = join(__dirname, 'followups')
const INBOX_DIR = join(__dirname, 'inbox')

mkdirSync(FOLLOWUPS_DIR, { recursive: true })
mkdirSync(INBOX_DIR, { recursive: true })

function writeFollowup(slug, { email, profile, subject, sentTo, replyPreview }) {
  const file = join(FOLLOWUPS_DIR, `${slug}.md`)
  const now = new Date().toISOString()
  let content = ''
  if (existsSync(file)) {
    content = readFileSync(file, 'utf-8')
  } else {
    content = `---
slug: ${slug}
email: ${email}
profile: ${profile}
subject: ${subject || ''}
created: ${now}
events: []
---\n\n`
  }

  // Append event
  const event = `- ${now} | sent reply to ${sentTo}${sentTo !== email ? ` (orig: ${email})` : ''}`
  content = content.replace(/events: \[(.*?)\]/s, (_, inner) => {
    const events = inner ? inner.split('\n').filter(l => l.trim()) : []
    events.push(event.trim())
    return `events:\n${events.map(e => `  ${e.replace(/^- /, '')}`).join('\n')}`
  })
  writeFileSync(file, content)
}

function getFollowup(slug) {
  const file = join(FOLLOWUPS_DIR, `${slug}.md`)
  if (!existsSync(file)) return null
  const content = readFileSync(file, 'utf-8')
  // Simple parse
  const frontMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontMatch) return null
  const front = {}
  frontMatch[1].split('\n').forEach(line => {
    const m = line.match(/^(\w+):\s*(.*)/)
    if (m) front[m[1]] = m[2]
  })
  // Parse events list
  const eventsMatch = content.match(/events:\n([\s\S]*?)(?=\n\w+:|$)/)
  front.events = eventsMatch ? eventsMatch[1].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()) : []
  return front
}

const app = express()
const PORT = process.env.PORT || 3457
const HOST = process.env.HOST || 'localhost'
const MCP_API = process.env.MCP_API || 'http://localhost:3456/call'
const MCP_TOKEN = process.env.EMAILMCP_MCP_TOKEN || process.env.MCP_TOKEN || ''
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`
const BASE_URL = PUBLIC_URL
const RESUME_NAME = process.env.RESUME_NAME || 'Your Name'
const RESUME_EMAIL = process.env.RESUME_EMAIL || 'you@example.com'
const RESUME_PHONE = process.env.RESUME_PHONE || '+1 (555) 000-0000'
const IMAP_CONFIG_PATH = join(__dirname, 'data', 'imap.json')

function loadImapConfig() {
  if (!existsSync(IMAP_CONFIG_PATH)) return null
  try { return JSON.parse(readFileSync(IMAP_CONFIG_PATH, 'utf-8')) } catch { return null }
}

function saveImapConfig(config) {
  writeFileSync(IMAP_CONFIG_PATH, JSON.stringify(config, null, 2))
}

async function callMcp(tool, args = {}, timeout = 10000) {
  const headers = { 'Content-Type': 'application/json' }
  if (MCP_TOKEN) headers['Authorization'] = `Bearer ${MCP_TOKEN}`
  const resp = await fetch(MCP_API, {
    method: 'POST', headers,
    body: JSON.stringify({ tool, arguments: args }),
    signal: AbortSignal.timeout(timeout)
  })
  return { status: resp.status, ...(await resp.json().catch(() => ({}))) }
}

app.use(express.json({ limit: '5mb' }))
app.use(express.static(new URL('./public', import.meta.url).pathname))
app.set('view engine', 'ejs')
app.set('views', new URL('./views', import.meta.url).pathname)

function buildReply(profileKey, resumeUrl, verification) {
  const profile = getProfile(profileKey)
  return `Thanks for reaching out.

I've put together a role-specific resume for you: ${resumeUrl}

Quick info:
- Target: $200-250K + equity (full-time) or $150-250/hr (contract)
- Status: Green Card holder — no sponsorship needed
- Stack: Node.js/TypeScript, WASM, WireGuard, DNS/SMTP at protocol level, distributed mesh, LXC/Docker

— ${RESUME_NAME}
${RESUME_EMAIL} | ${RESUME_PHONE}
${verification.tier === 'suspicious' ? '\nPS — Could you share your LinkedIn profile? Helps me keep track of conversations.' : ''}`
}

async function processEmail({ from, subject, body, auth, replyTo }) {
  const emailMatch = from?.match(/<(.+?)>/) || [null, from]
  const email = (emailMatch[1] || from || '').trim()
  const domain = email.split('@')[1]?.toLowerCase() || ''
  const fromName = from?.replace(/<.*>/, '').replace(/"/g, '').trim() || email

  const profileKey = matchProfile(subject || '', body || '')
  const verification = await verifyRecruiter({ from: from || '', domain, subject: subject || '', body: body || '', auth, replyTo })
  const slug = nanoid(8)

  return { email, domain, fromName, profileKey, verification, slug }
}

async function sendEmail(email, subject, replyText) {
  return callMcp('send_email', { to: [email], subject, text: replyText })
}

// ═══ Routes ═══════════════════════════════════════════════════════

app.get('/', (req, res) => res.redirect('/admin'))
app.get('/health', (req, res) => {
  res.json({ ok: true, profiles: listProfiles() })
})

app.get('/api/status', async (req, res) => {
  const status = { mcp: false, imap: false, mcpError: null }
  if (MCP_API) {
    try {
      const data = await callMcp('email_check_email_config', {}, 5000)
      status.mcp = !!data
      status.imap = !!(data?.result?.imap_configured || data?.imap_configured || data?.imap)
      if (!status.mcp) status.mcpError = data?.error || 'unknown'
    } catch (e) {
      status.mcpError = e.message
    }
  }
  res.json(status)
})

// ── Email settings ──────────────────────────────────────────────
app.get('/settings', (req, res) => {
  res.render('settings', { BASE_URL, imapConfig: loadImapConfig() })
})

app.get('/api/email/check', async (req, res) => {
  if (!MCP_API) return res.json({ ok: false, error: 'MCP not configured' })
  try {
    const data = await callMcp('email_check_email_config', {})
    res.json(data)
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

app.post('/api/email/imap', async (req, res) => {
  const { host, port, email, password } = req.body
  if (!host || !email || !password) return res.status(400).json({ error: 'host, email, password required' })

  const config = { host, port: port || 993, email, password }
  saveImapConfig(config)

  // Test the connection
  try {
    const data = await callMcp('email_get_mailbox_status', {
      imap_config: config,
      mailbox: 'INBOX'
    }, 10000)
    res.json({ ok: true, connected: !!data, details: data })
  } catch (e) {
    res.json({ ok: true, saved: true, connected: false, error: e.message })
  }
})

app.post('/api/email/test', async (req, res) => {
  if (!MCP_API) return res.json({ ok: false, error: 'MCP not configured' })
  try {
    const data = await callMcp('email_test_email_config', {})
    res.json(data)
  } catch (e) {
    res.json({ ok: false, error: e.message })
  }
})

// ── Session management ─────────────────────────────────────────
app.get('/api/session', (req, res) => {
  res.json({ active: getActiveSession(), sessions: listSessions() })
})

app.post('/api/session/switch', (req, res) => {
  const { id } = req.body
  if (!id) return res.status(400).json({ error: 'id required' })
  if (!switchSession(id)) return res.status(404).json({ error: 'session not found' })
  res.json({ ok: true, active: getActiveSession() })
})

app.post('/api/session/new', async (req, res) => {
  const days = parseInt(req.body.days) || 0
  const session = createSession(days)

  const results = { session, inboxFiles: 0, imapEmails: 0, total: 0, skippedFiles: 0 }

  // Scan inbox .md files
  if (existsSync(INBOX_DIR)) {
    const files = readdirSync(INBOX_DIR).filter(f => f.endsWith('.md') && f !== 'README.md')
    for (const f of files) {
      const raw = readFileSync(join(INBOX_DIR, f), 'utf-8')
      const { data, content } = matter(raw)
      const from = data.from
      const subject = data.subject
      const body = content || ''
      const auth = data.auth || null
      const replyTo = data.replyTo || null
      if (!from || !subject) {
        results.skippedFiles = (results.skippedFiles || 0) + 1
        continue
      }
      try {
        const { email, fromName, profileKey, verification, slug } = await processEmail({ from, subject, body, auth, replyTo })
        if (!emailAlreadyProcessed(email)) {
          createSlug({ slug, email, profile: profileKey, subject, fromName, trust: verification.trust, tier: verification.tier, flags: verification.flags, linkedinUrl: verification.linkedinUrl, status: 'pending', bodyPreview: body.substring(0, 800) })
          results.total++
          results.inboxFiles++
        }
      } catch (e) {
        console.error(`Inbox file ${f}:`, e.message)
      }
    }
  }

  // Optional: import from email MCP (IMAP)
  if (days > 0 && MCP_API) {
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0]
    const imapCfg = loadImapConfig()
    const args = { filter: { since, limit: 200 }, options: { include_body: true } }
    if (imapCfg) args.imap_config = imapCfg
    try {
      const mcpResp = await callMcp('email_read_inbox', args, 30000)
      const emails = mcpResp?.result?.emails || mcpResp?.emails || []
      for (const em of emails) {
        const from = em.from || em.sender
        const subject = em.subject || ''
        const body = em.body || em.text || em.preview || ''
        const auth = em.auth || null
        const replyTo = em.replyTo || em['reply-to'] || null
        if (!from) continue
        try {
          const { email, fromName, profileKey, verification, slug } = await processEmail({ from, subject, body, auth, replyTo })
          if (!emailAlreadyProcessed(email)) {
            createSlug({ slug, email, profile: profileKey, subject, fromName, trust: verification.trust, tier: verification.tier, flags: verification.flags, linkedinUrl: verification.linkedinUrl, status: 'pending', bodyPreview: body.substring(0, 800) })
            results.total++
            results.imapEmails++
          }
        } catch (e) {
          console.error(`IMAP email ${from}:`, e.message)
        }
      }
    } catch (e) {
      console.error('IMAP fetch failed:', e.message)
      results.imapError = e.message
    }
  }

  console.log(`Session ${session.id}: ${results.total} imported (${results.inboxFiles} inbox, ${results.imapEmails} imap)`)
  res.json({ ok: true, ...results })
})

// Admin — review queue with checkboxes
app.get('/admin', (req, res) => {
  const all = getAllStats()
  const pending = all.filter(r => r.status === 'pending')
  const sent = all.filter(r => r.status === 'sent')
  const skipped = all.filter(r => r.status === 'skipped')
  const session = getActiveSession()
  const sessions = listSessions()
  res.render('admin', { all, pending, sent, skipped, BASE_URL, session, sessions })
})

// Webhook — stores as pending, no auto-send
app.post('/api/incoming', async (req, res) => {
  // Accept both raw body and email MCP webhook format (preview)
  const from = req.body.from
  const subject = req.body.subject
  const emailBody = req.body.body || req.body.preview || ''
  const auth = req.body.auth || null
  const replyTo = req.body.replyTo || req.body['reply-to'] || null
  if (!from || !subject) return res.status(400).json({ error: 'Missing fields' })

  try {
    const { email, fromName, profileKey, verification, slug } = await processEmail({ from, subject, body: emailBody, auth, replyTo })

    if (emailAlreadyProcessed(email)) {
      return res.json({ ok: true, slug: null, profile: profileKey, trust: verification.tier, status: 'skipped', reason: 'already_processed' })
    }

  createSlug({
    slug, email, profile: profileKey, subject, fromName,
    trust: verification.trust, tier: verification.tier,
    flags: verification.flags, linkedinUrl: verification.linkedinUrl,
    status: 'pending', bodyPreview: emailBody.substring(0, 800)
  })

  console.log(`Stored pending: ${email} | ${profileKey} | ${verification.tier}`)
  res.json({ ok: true, slug, profile: profileKey, trust: verification.tier, status: 'pending' })
  } catch(e) {
    console.error('Webhook error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// Batch import — process list of emails, store as pending
app.post('/api/import', async (req, res) => {
  const emails = req.body.emails || []
  if (!Array.isArray(emails)) return res.status(400).json({ error: 'emails array required' })

  const results = []
  for (const em of emails) {
    try {
      const { email, fromName, profileKey, verification, slug } = await processEmail(em)
      if (emailAlreadyProcessed(email)) {
        results.push({ email, profile: profileKey, slug: null, skipped: true, reason: 'already processed' })
        continue
      }
      createSlug({
        slug, email, profile: profileKey, subject: em.subject, fromName,
        trust: verification.trust, tier: verification.tier,
        flags: verification.flags, linkedinUrl: verification.linkedinUrl,
        status: 'pending', bodyPreview: (em.body || '').substring(0, 800)
      })
      results.push({ email, profile: profileKey, slug, verification: verification.tier })
    } catch (e) {
      results.push({ email: em.from, error: e.message })
    }
  }

  console.log(`Imported ${results.filter(r => r.slug).length} pending, ${results.filter(r => r.skipped).length} skipped`)
  res.json({ ok: true, imported: results.filter(r => r.slug).length, skipped: results.filter(r => r.skipped).length, results })
})

// Approve selected slugs — send emails (test_to overrides recipient for testing)
app.post('/api/approve', async (req, res) => {
  const slugs = req.body.slugs || []
  const testTo = req.body.test_to || null
  if (!Array.isArray(slugs)) return res.status(400).json({ error: 'slugs array required' })

  const results = []
  for (const slug of slugs) {
    const data = getSlug(slug)
    if (!data) { results.push({ slug, error: 'not found' }); continue }
    if (data.status === 'sent') { results.push({ slug, skipped: true, reason: 'already sent' }); continue }

    const sendTo = testTo || data.email
    const resumeUrl = `${BASE_URL}/${slug}`
    const verification = { tier: data.trust_tier }
    const replyText = buildReply(data.profile, resumeUrl, verification)

    try {
      const mcpResult = await sendEmail(sendTo, `Re: ${(data.subject || '').replace(/^(Re:\s*)?/i, '')}`, replyText)
      updateStatus(slug, 'sent')
      writeFollowup(slug, { email: data.email, profile: data.profile, subject: data.subject, sentTo: sendTo, replyPreview: replyText.substring(0, 200) })
      console.log(`Sent to ${sendTo} (orig: ${data.email}) | ${data.profile} | MCP: ${mcpResult.status}`)
      results.push({ slug, email: sendTo, original: testTo ? data.email : null, sent: true, mcpStatus: mcpResult.status })
    } catch (e) {
      results.push({ slug, error: e.message })
    }
  }

  res.json({ ok: true, sent: results.filter(r => r.sent).length, test_mode: !!testTo, results })
})

// Skip selected slugs
app.post('/api/skip', (req, res) => {
  const slugs = req.body.slugs || []
  slugs.forEach(s => updateStatus(s, 'skipped'))
  res.json({ ok: true, skipped: slugs.length })
})

// Delete selected slugs
app.post('/api/delete', (req, res) => {
  const slugs = req.body.slugs || []
  slugs.forEach(s => deleteSlug(s))
  res.json({ ok: true, deleted: slugs.length })
})

// Clear entire session
app.post('/api/session/clear', (req, res) => {
  clearSession()
  res.json({ ok: true })
})

// Deep verify — returns slug info for Chrome MCP scraping
app.get('/api/deep-verify/:slug', (req, res) => {
  const data = getSlug(req.params.slug)
  if (!data) return res.status(404).json({ error: 'not found' })
  res.json({
    slug: data.slug,
    email: data.email,
    profile: data.profile,
    linkedinUrl: data.linkedin_url,
    fromName: data.from_name,
    trustTier: data.trust_tier,
    flags: data.flags
  })
})

// Accept LinkedIn profile data from Chrome MCP scrape
app.post('/api/verify-result', (req, res) => {
  const { slug, linkedinData } = req.body
  if (!slug || !linkedinData) return res.status(400).json({ error: 'slug and linkedinData required' })

  const data = getSlug(slug)
  if (!data) return res.status(404).json({ error: 'not found' })

  const result = scoreLinkedInProfile(linkedinData)
  const existingFlags = data.flags ? JSON.parse(data.flags) : []
  const newFlags = [...new Set([...existingFlags, ...result.flags])]

  updateTrust(slug, result.trustDelta, result.tier, JSON.stringify(newFlags))
  console.log(`Deep verify ${slug}: completeness=${result.completeness}% tier=${result.tier}`)

  res.json({ ok: true, slug, completeness: result.completeness, tier: result.tier, flags: result.flags, trustDelta: result.trustDelta })
})

// Followup history
app.get('/api/followup/:slug', (req, res) => {
  const f = getFollowup(req.params.slug)
  res.json(f || { events: [] })
})

// ── Word download ────────────────────────────────────────────────
app.get('/:slug', (req, res) => {
  const data = getSlug(req.params.slug)
  if (!data) return res.status(404).send('Not found')

  logVisit(req.params.slug, req.ip, req.get('User-Agent'))

  const { tags } = getProfile(data.profile)
  const experiences = filterForProfile(loadExperiences(), tags)

  res.render('resume', {
    profile: data.profile,
    profileTitle: getProfile(data.profile).title,
    summary: getProfile(data.profile).summary,
    experiences,
    skills: getSkills(data.profile),
    contact: getContact(),
    slug: data.slug
  })
})

// ── Resume page ──────────────────────────────────────────────────
app.get('/download/:slug', (req, res) => {
  const data = getSlug(req.params.slug)
  if (!data) return res.status(404).send('Not found')

  const profile = getProfile(data.profile)
  const { tags } = profile
  const experiences = filterForProfile(loadExperiences(), tags)
  const skills = getSkills(data.profile)
  const contact = getContact()

  const children = [
    new Paragraph({ text: 'Nicolas Philippe Fodor', heading: HeadingLevel.HEADING_1, spacing: { after: 80 } }),
    new Paragraph({ text: profile.title, spacing: { after: 40 }, style: 'Subtitle' }),
    new Paragraph({ text: `${contact.email} | ${contact.phone} | ${contact.location}`, spacing: { after: 40 } }),
    new Paragraph({ text: 'Professional Summary', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } }),
    new Paragraph({ text: profile.summary, spacing: { after: 120 } }),
    new Paragraph({ text: 'Experience', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } }),
  ]

  experiences.forEach(exp => {
    children.push(
      new Paragraph({ text: `${exp.title} | ${exp.company}`, heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 40 } }),
      new Paragraph({ text: exp.dates, spacing: { after: 60 }, italics: true }),
      ...exp.bullets.map(b => new Paragraph({
        text: b.text,
        bullet: { level: 0 },
        spacing: { after: 40 }
      }))
    )
  })

  children.push(new Paragraph({ text: 'Technical Skills', heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 } }))
  skills.forEach(group => {
    children.push(new Paragraph({
      children: [
        new TextRun({ text: `${group.category}: `, bold: true }),
        new TextRun(group.items.join(', '))
      ],
      spacing: { after: 40 }
    }))
  })

  const doc = new Document({
    sections: [{
      properties: {},
      children
    }]
  })

  Packer.toBuffer(doc).then(buffer => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    res.setHeader('Content-Disposition', `attachment; filename="Nicolas_Fodor_${profile.title.replace(/\s+/g,'_')}.docx"`)
    res.send(buffer)
  }).catch(err => {
    res.status(500).send('Failed to generate document')
  })
})

app.listen(PORT, HOST, () => {
  console.log(`Resume engine running at ${BASE_URL} (${HOST}:${PORT})`)
})
