import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const raw = readFileSync(join(__dirname, '..', 'profiles.json'), 'utf-8')
const config = JSON.parse(raw)

const profiles = config.profiles
const skill_map = config.skill_map
const skills = config.skills
const contact = config.contact

export function matchProfile(subject, body) {
  const text = `${subject} ${body}`.toLowerCase()
  let best = null
  let bestScore = 0

  for (const [key, profile] of Object.entries(profiles)) {
    if (key === 'default') continue
    let score = 0
    for (const kw of profile.keywords) {
      const lower = kw.toLowerCase()
      if (text.includes(lower)) {
        score += lower.split(' ').length  // longer keywords = better match
      }
    }
    if (score > bestScore) {
      bestScore = score
      best = key
    }
  }

  return bestScore > 0 ? best : 'default'
}

export function getProfile(key) {
  return profiles[key] || profiles.default
}

export function getSkills(profileKey) {
  const keys = skill_map[profileKey] || skill_map.default
  return keys.map(k => ({
    category: k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    items: skills[k] || []
  })).filter(s => s.items.length > 0)
}

export function getContact() {
  return contact
}

export function listProfiles() {
  return Object.keys(profiles).filter(k => k !== 'default')
}
