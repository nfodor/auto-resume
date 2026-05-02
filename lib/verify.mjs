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

const BODY_SHOP_DOMAINS = [
  'tanishasystems.com', 'eteaminc.com', 'imcsgroup.net', 'vbeyond.com',
  'xchangesoft.net', 'cyberthink.com', 'e-solutionsinc.com',
  'saxonglobal.com', 'quantumworldit.com'
]

export async function verifyRecruiter({ from, domain, subject, body, auth }) {
  const score = { trust: 0, flags: [] }
  const text = `${subject} ${body}`

  // ── DKIM/DMARC/SPF check ──────────────────────────────────────
  if (auth) {
    const authRes = auth.authenticationResults || ''
    if (authRes.includes('dkim=pass')) {
      score.trust += 20
      score.flags.push('dkim_pass')
    } else if (authRes.includes('dkim=fail')) {
      score.trust -= 50
      score.flags.push('dkim_fail')
    }
    if (authRes.includes('dmarc=pass')) {
      score.trust += 20
      score.flags.push('dmarc_pass')
    } else if (authRes.includes('dmarc=fail')) {
      score.trust -= 40
      score.flags.push('dmarc_fail')
    }
    if (authRes.includes('spf=pass')) {
      score.trust += 10
      score.flags.push('spf_pass')
    } else if (authRes.includes('spf=fail') || authRes.includes('spf=softfail')) {
      score.trust -= 20
      score.flags.push('spf_fail')
    }

    // Return-Path mismatch (envelope from vs header from)
    const returnPath = auth.returnPath || ''
    if (returnPath && domain) {
      const returnDomain = returnPath.match(/@([^\s>]+)/)?.[1]
      if (returnDomain && !returnDomain.includes(domain) && !domain.includes(returnDomain)) {
        score.trust -= 30
        score.flags.push('return_path_mismatch')
      }
    }
  }

  // Domain checks
  if (HIGH_TRUST_DOMAINS.some(d => domain?.includes(d))) {
    score.trust += 40
    score.flags.push('trusted_company')
  }

  if (BODY_SHOP_DOMAINS.some(d => domain?.includes(d))) {
    score.trust -= 20
    score.flags.push('body_shop')
  }

  // Free email domains (Gmail recruiters are suspicious unless known)
  const freeDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com']
  if (freeDomains.includes(domain?.toLowerCase())) {
    score.trust -= 15
    score.flags.push('free_email')
  }

  // Spammy language patterns
  for (const pattern of SPAMMY_PATTERNS) {
    if (pattern.test(text)) {
      score.trust -= 10
      score.flags.push('spammy_language')
      break
    }
  }

  // Generic irrelevant roles
  for (const pattern of SUSPICIOUS_ROLES) {
    if (pattern.test(subject)) {
      score.trust -= 10
      score.flags.push('irrelevant_role')
      break
    }
  }

  // LinkedIn presence
  const hasLinkedIn = /linkedin\.com\/in\/\w+/i.test(body)
  if (hasLinkedIn) {
    score.trust += 25
    score.flags.push('linkedin_present')
  }

  // Phone number presence (real recruiters leave contact)
  const hasPhone = /\+?1?\s*\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}/.test(body)
  if (hasPhone) {
    score.trust += 10
    score.flags.push('phone_present')
  }

  // Look for signature block (indicates real person)
  const hasSignature = /(thanks|regards|best|cheers|sincerely)[,\s]*$/im.test(text) ||
    /\n--\s*\n/.test(body) ||
    /@[\w.]+\.(com|io|co|net)/.test(body)
  if (hasSignature) {
    score.trust += 5
    score.flags.push('has_signature')
  }

  // Extract LinkedIn URL for verification
  const linkedinMatch = body.match(/linkedin\.com\/in\/([\w-]+)/i)
  const linkedinUrl = linkedinMatch ? `https://www.${linkedinMatch[0]}` : null

  // ── LinkedIn profile verification ─────────────────────────────
  if (linkedinMatch && linkedinUrl) {
    const linkedinName = linkedinMatch[1].replace(/-/g, ' ').toLowerCase()
    const fromName = (from || '').replace(/<.*>/, '').replace(/"/g, '').trim().toLowerCase()
    const nameParts = fromName.split(/\s+/).filter(p => p.length > 1)
    const nameMatch = nameParts.some(part => linkedinName.includes(part))

    if (!nameMatch) {
      score.trust -= 50
      score.flags.push('linkedin_name_mismatch')
      if (HIGH_TRUST_DOMAINS.some(d => domain?.includes(d))) {
        score.trust -= 30
        score.flags.push('impersonating_trusted_domain')
      }
    }

    // Scrape LinkedIn public profile for signals
    try {
      const resp = await fetch(linkedinUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        redirect: 'follow',
        signal: AbortSignal.timeout(5000)
      })
      const html = await resp.text()

      // Check canonical locale — non-US locale is suspicious for US recruiter
      const canonMatch = html.match(/canonical" href="https:\/\/(\w+)\.linkedin\.com/)
      if (canonMatch && canonMatch[1] !== 'www' && canonMatch[1] !== 'us') {
        score.trust -= 30
        score.flags.push(`linkedin_locale_${canonMatch[1]}`)
      }

      // Check member ID — 0 means restricted/invalid
      if (html.includes('data-member-id="0"')) {
        score.trust -= 20
        score.flags.push('linkedin_restricted')
      }

      // Extract title/headline for role mismatch
      const headlineMatch = html.match(/<title>([^<]+)<\/title>/)
      if (headlineMatch) {
        const title = headlineMatch[1].toLowerCase()
        const recruiterTerms = ['recruiter', 'talent', 'hiring', 'people', 'sourcer', 'staffing', 'acquisition']
        const isRecruiter = recruiterTerms.some(t => title.includes(t))
        if (isRecruiter) {
          score.trust += 15
          score.flags.push('linkedin_recruiter_title')
        } else {
          score.trust -= 25
          score.flags.push('linkedin_not_recruiter')
        }
      }
    } catch {
      // LinkedIn unreachable — neutral, don't penalize
      score.flags.push('linkedin_unreachable')
    }
  }

  return {
    trust: Math.max(-50, Math.min(100, score.trust)),
    flags: score.flags,
    tier: score.trust >= 50 ? 'verified' : score.trust >= 0 ? 'unverified' : 'suspicious',
    linkedinUrl
  }
}
