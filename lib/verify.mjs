// Recruiter verification — scores trustworthiness based on signals

const SPAMMY_PATTERNS = [
  /urgent.*requirement/i, /immediate.*position/i, /hotlist/i,
  /kindly\s+(find|share|review)/i, /do\s+the\s+needful/i,
  /please\s+revert/i, /dear\s+sir/i, /greetings\s+of\s+the\s+day/i,
  /best\s+regards{2,}/i
]

const SUSPICIOUS_ROLES = [
  /solution\s*architect/i, /java\s*architect/i, /\.net/i,
  /salesforce/i, /sap\s*consultant/i, /pega/i
]

const HIGH_TRUST_DOMAINS = [
  'google.com', 'meta.com', 'apple.com', 'microsoft.com', 'amazon.com',
  'netflix.com', 'stripe.com', 'airbnb.com', 'uber.com', 'linkedin.com',
  'dropbox.com', 'github.com', 'gitlab.com', 'datadoghq.com', 'docker.com',
  'ramp.com', 'mercury.com', 'vercel.com', 'notion.so', 'linear.app',
  'a16z.com', 'sequoiacap.com', 'greylock.com', 'foundersfund.com',
  'benchmark.com', 'accel.com', 'lightspeed.com', 'ycombinator.com'
]

const FREE_DOMAINS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com']

export async function verifyRecruiter({ from, domain, subject, body, auth, replyTo }) {
  const score = { trust: 0, flags: [] }
  const text = `${subject} ${body}`

  // ── DKIM/DMARC/SPF check ──────────────────────────────────────
  if (auth) {
    const authRes = auth.authenticationResults || ''
    if (authRes.includes('dkim=pass')) {
      score.trust += 20; score.flags.push('dkim_pass')
    } else if (authRes.includes('dkim=fail')) {
      score.trust -= 50; score.flags.push('dkim_fail')
    }
    if (authRes.includes('dmarc=pass')) {
      score.trust += 20; score.flags.push('dmarc_pass')
    } else if (authRes.includes('dmarc=fail')) {
      score.trust -= 40; score.flags.push('dmarc_fail')
    }
    if (authRes.includes('spf=pass')) {
      score.trust += 10; score.flags.push('spf_pass')
    } else if (authRes.includes('spf=fail') || authRes.includes('spf=softfail')) {
      score.trust -= 20; score.flags.push('spf_fail')
    }

    // Return-Path mismatch
    const returnPath = auth.returnPath || ''
    if (returnPath && domain) {
      const returnDomain = returnPath.match(/@([^\s>]+)/)?.[1]
      if (returnDomain && !returnDomain.includes(domain) && !domain.includes(returnDomain)) {
        score.trust -= 30; score.flags.push('return_path_mismatch')
      }
    }
  }

  // ── Reply-To consistency ─────────────────────────────────────
  if (replyTo && domain) {
    const replyDomain = replyTo.match(/@(.+)/)?.[1]?.toLowerCase()
    if (replyDomain && !replyDomain.includes(domain) && !domain.includes(replyDomain)) {
      score.trust -= 25; score.flags.push('reply_to_mismatch')
    }
  }

  // ── Domain checks ────────────────────────────────────────────
  if (HIGH_TRUST_DOMAINS.some(d => domain?.includes(d))) {
    score.trust += 40; score.flags.push('trusted_company')
  }

  if (FREE_DOMAINS.includes(domain?.toLowerCase())) {
    score.trust -= 15; score.flags.push('free_email')
  }

  // ── Spammy language ─────────────────────────────────────────
  for (const pattern of SPAMMY_PATTERNS) {
    if (pattern.test(text)) {
      score.trust -= 10; score.flags.push('spammy_language')
      break
    }
  }

  for (const pattern of SUSPICIOUS_ROLES) {
    if (pattern.test(subject)) {
      score.trust -= 10; score.flags.push('irrelevant_role')
      break
    }
  }

  // ── Body signals ─────────────────────────────────────────────
  const hasLinkedIn = /linkedin\.com\/in\/[\w-]+/i.test(body)
  if (hasLinkedIn) {
    score.trust += 25; score.flags.push('linkedin_present')
  }

  const hasPhone = /\+?1?\s*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(body)
  if (hasPhone) {
    score.trust += 10; score.flags.push('phone_present')
  }

  const hasSignature = /(thanks|regards|best|cheers|sincerely)[,\s]*$/im.test(text) ||
    /\n--\s*\n/.test(body) || /@[\w.]+\.(com|io|co|net)/.test(body)
  if (hasSignature) {
    score.trust += 5; score.flags.push('has_signature')
  }

  // Extract LinkedIn URL
  const linkedinMatch = body.match(/linkedin\.com\/in\/([\w-]+)/i)
  const linkedinUrl = linkedinMatch ? `https://www.${linkedinMatch[0]}` : null

  // ── LinkedIn name match (no scraping needed) ──────────────────
  if (linkedinMatch) {
    const linkedinName = linkedinMatch[1].replace(/-/g, ' ').toLowerCase()
    const fromName = (from || '').replace(/<.*>/, '').replace(/"/g, '').trim().toLowerCase()
    const nameParts = fromName.split(/\s+/).filter(p => p.length > 1)
    const nameMatch = nameParts.some(part => linkedinName.includes(part))

    if (!nameMatch) {
      score.trust -= 50; score.flags.push('linkedin_name_mismatch')
      if (HIGH_TRUST_DOMAINS.some(d => domain?.includes(d))) {
        score.trust -= 30; score.flags.push('impersonating_trusted_domain')
      }
    }
  }

  // ── Server-side LinkedIn scrape (shallow signals) ─────────────
  let linkedinData = null
  if (linkedinUrl) {
    try {
      const resp = await fetch(linkedinUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000)
      })
      const html = await resp.text()

      if (!html.includes('authwall')) {
        linkedinData = extractLinkedInSignals(html)
        score.trust += linkedinData.score
        score.flags.push(...linkedinData.flags)
      } else {
        // Blocked by authwall — neutral, mark for deep verify
        score.flags.push('linkedin_authwall')
        linkedinData = { authwall: true }
      }
    } catch {
      score.flags.push('linkedin_unreachable')
    }
  }

  return {
    trust: Math.max(-50, Math.min(100, score.trust)),
    flags: score.flags,
    tier: score.trust >= 50 ? 'verified' : score.trust >= 0 ? 'unverified' : 'suspicious',
    linkedinUrl,
    linkedinData
  }
}

// ── Extract signals from LinkedIn public profile HTML ──────────
function extractLinkedInSignals(html) {
  const signals = { score: 0, flags: [] }

  // Profile photo
  if (/profile-picture|pv-shadowed-profile-photo__img|EntityPhoto/.test(html)) {
    signals.score += 15; signals.flags.push('li_has_photo')
  } else if (!/ghost-person/.test(html)) {
    signals.score -= 15; signals.flags.push('li_no_photo')
  }

  // Headline/title tag
  const titleMatch = html.match(/<title>([^<]+)<\/title>/)
  if (titleMatch) {
    const title = titleMatch[1].trim()
    if (title.length > 20) {
      signals.score += 5; signals.flags.push('li_rich_headline')
    } else {
      signals.score -= 5; signals.flags.push('li_thin_headline')
    }

    const recruiterTerms = ['recruiter', 'talent', 'hiring', 'people', 'sourcer', 'staffing', 'acquisition']
    if (recruiterTerms.some(t => title.toLowerCase().includes(t))) {
      signals.score += 15; signals.flags.push('li_recruiter_title')
    }
  }

  // About section
  const aboutSection = html.match(/"about":\{"text":"([^"]+)"/)
  if (aboutSection && aboutSection[1].length > 100) {
    signals.score += 10; signals.flags.push('li_rich_about')
  } else if (aboutSection) {
    signals.score -= 5; signals.flags.push('li_thin_about')
  }

  // Position count
  const positionMatches = html.match(/data-field="experience_position_title"/g)
  const posCount = positionMatches ? positionMatches.length : 0
  if (posCount >= 3) {
    signals.score += 10; signals.flags.push('li_multiple_positions')
  } else if (posCount === 0) {
    signals.score -= 20; signals.flags.push('li_no_positions')
  }

  // Location
  if (/location|geo|address/.test(html) && /locality|region|country/.test(html)) {
    signals.score += 5; signals.flags.push('li_has_location')
  } else {
    signals.score -= 5; signals.flags.push('li_no_location')
  }

  // Education
  if (/education|school|degree|university/i.test(html) && /data-field="education/.test(html)) {
    signals.score += 5; signals.flags.push('li_has_education')
  }

  // Canonical locale check (non-US = suspicious for US recruiter)
  const canonMatch = html.match(/canonical" href="https:\/\/(\w+)\.linkedin\.com/)
  if (canonMatch && canonMatch[1] !== 'www' && canonMatch[1] !== 'us') {
    signals.score -= 15; signals.flags.push(`li_locale_${canonMatch[1]}`)
  }

  // Member ID check
  if (html.includes('data-member-id="0"')) {
    signals.score -= 20; signals.flags.push('li_restricted')
  }

  return signals
}

// ── Score LinkedIn data from external source (Chrome MCP) ──────
export function scoreLinkedInProfile(profileData) {
  const score = 0
  const flags = []

  if (profileData.hasPhoto) {
    flags.push('li_deep_photo')
    // photo not scored directly (could be stock)
  }
  if (profileData.connections > 500) {
    flags.push('li_deep_connections_500plus')
    // connections not directly scored (some limit visibility)
  }
  if (profileData.followers > 100) {
    flags.push('li_deep_followers_100plus')
  }
  if (profileData.headline && profileData.headline.length > 30) {
    flags.push('li_deep_rich_headline')
  }
  if (profileData.about && profileData.about.length > 100) {
    flags.push('li_deep_rich_about')
  }
  if (profileData.positionCount >= 3) {
    flags.push('li_deep_multiple_positions')
  }
  if (profileData.hasEducation) {
    flags.push('li_deep_has_education')
  }
  if (profileData.hasLocation) {
    flags.push('li_deep_has_location')
  }
  if (profileData.skillsCount >= 5) {
    flags.push('li_deep_skills')
  }

  // Compute profile completeness score (0-100)
  let completeness = 0
  if (profileData.hasPhoto) completeness += 15
  if (profileData.headline?.length > 30) completeness += 15
  if (profileData.about?.length > 100) completeness += 20
  if (profileData.positionCount >= 3) completeness += 20
  if (profileData.hasEducation) completeness += 10
  if (profileData.hasLocation) completeness += 10
  if (profileData.skillsCount >= 5) completeness += 10

  const trustDelta = completeness - 50 // below 50% complete = suspicious
  const tier = completeness >= 60 ? 'verified' : completeness >= 30 ? 'unverified' : 'suspicious'

  return { trustDelta, tier, flags, completeness }
}
