import { readFileSync, readdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import matter from 'gray-matter'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXPERIENCES_DIR = join(__dirname, '..', 'experiences')

let _cache = null

export function loadExperiences() {
  if (_cache) return _cache
  const files = readdirSync(EXPERIENCES_DIR).filter(f => f.endsWith('.md'))
  _cache = files.map(f => {
    const raw = readFileSync(join(EXPERIENCES_DIR, f), 'utf-8')
    const { data, content } = matter(raw)
    const bullets = content
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('- ['))
      .map(l => {
        const m = l.match(/^-\s*\[([^\]]+)\]\s*(.+)/)
        if (!m) return null
        return { tags: m[1].split(',').map(t => t.trim()), text: m[2] }
      })
      .filter(Boolean)
    return { slug: f.replace('.md', ''), ...data, bullets }
  }).sort((a, b) => (a.weight || 99) - (b.weight || 99))
  return _cache
}

export function filterForProfile(experiences, tags) {
  return experiences
    .map(exp => ({
      ...exp,
      bullets: exp.bullets.filter(b => b.tags.some(t => tags.includes(t)))
    }))
    .filter(exp => exp.bullets.length > 0)
}

export function getAllTags(experiences) {
  const set = new Set()
  experiences.forEach(exp => exp.tags?.forEach(t => set.add(t)))
  return [...set]
}
