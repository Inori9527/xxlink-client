import { readFile } from 'node:fs/promises'
import path from 'node:path'

const CHANGELOG_PATH = path.resolve(process.cwd(), 'Changelog.md')

function normalizeTag(tag) {
  return tag.startsWith('v') ? tag : `v${tag}`
}

function extractSection(content, heading) {
  const normalized = content.replace(/\r\n/g, '\n')
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const sectionRegex = new RegExp(
    `^##\\s+${escapedHeading}\\s*$([\\s\\S]*?)(?=^##\\s+v?\\d+\\.\\d+\\.\\d+\\s*$|\\Z)`,
    'm',
  )
  const match = normalized.match(sectionRegex)
  return match?.[1]?.trim() ?? ''
}

async function readChangelog() {
  try {
    return await readFile(CHANGELOG_PATH, 'utf8')
  } catch {
    return ''
  }
}

export async function resolveUpdateLog(tag) {
  const changelog = await readChangelog()
  if (!changelog) {
    return `Release ${normalizeTag(tag)} is available.`
  }

  const normalizedTag = normalizeTag(tag)
  const section =
    extractSection(changelog, normalizedTag) ||
    extractSection(changelog, normalizedTag.replace(/^v/, ''))

  return section || `Release ${normalizedTag} is available.`
}

export async function resolveUpdateLogDefault() {
  const changelog = await readChangelog()
  if (!changelog) {
    return 'A new version is available.'
  }

  const normalized = changelog.replace(/\r\n/g, '\n')
  const match = normalized.match(
    /^##\s+v?\d+\.\d+\.\d+\s*$([\s\S]*?)(?=^##\s+v?\d+\.\d+\.\d+\s*$|\Z)/m,
  )

  return match?.[1]?.trim() || 'A new version is available.'
}
