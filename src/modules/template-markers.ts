/**
 * Template discovery and marker extraction utilities
 */
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../utils/logger.js'
// Use carbone internals (commonjs) – require to access non-exported utilities
// eslint-disable-next-line @typescript-eslint/no-var-requires
const carboneFile = require('carbone/lib/file')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const carboneParser = require('carbone/lib/parser')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const carbonePreprocessor = require('carbone/lib/preprocessor')

export interface TemplateInfo {
  name: string // filename without extension
  file: string // full filename
  path: string // absolute path
  size: number
  markers: string[]
  extractedAt: string
}

// Cache of template markers keyed by absolute path
const templateCache: Record<string, TemplateInfo> = {}

/**
 * Returns the directory containing DOCX templates. Mirrors existing conversion module structure.
 */
export function getTemplatesDir(): string {
  return path.join(__dirname, 'templates')
}

/**
 * Lists available .docx templates in the templates directory
 */
export function listTemplates(): TemplateInfo[] {
  const dir = getTemplatesDir()
  let files: string[] = []
  try {
    files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.docx'))
  } catch {
    return []
  }

  return files.map(f => ensureTemplateInfo(path.join(dir, f)))
}

/**
 * Ensures template info is in cache (extracting markers if needed)
 */
export function ensureTemplateInfo(templatePath: string): TemplateInfo {
  const stat = safeStat(templatePath)
  if (!stat) {
    throw new Error(`Template missing: ${templatePath}`)
  }

  const cacheHit = templateCache[templatePath]
  if (cacheHit && cacheHit.size === stat.size) {
    return cacheHit
  }

  const markers = extractMarkersWithCarbone(templatePath)
  const info: TemplateInfo = {
    name: path.basename(templatePath).replace(/\.docx$/i, ''),
    file: path.basename(templatePath),
    path: templatePath,
    size: stat.size,
    markers: Array.from(new Set(markers)).sort(),
    extractedAt: new Date().toISOString()
  }
  templateCache[templatePath] = info
  return info
}

/**
 * Safe fs.stat wrapper
 */
function safeStat(p: string): fs.Stats | null {
  try { return fs.statSync(p) } catch { return null }
}

/**
 * Extract markers by leveraging carbone internals: open template, preprocess XML, run parser.findMarkers.
 */
function extractMarkersWithCarbone(templatePath: string): string[] {
  try {
    const tpl = carboneFile.openTemplateSync ? carboneFile.openTemplateSync(templatePath) : null
    // If sync not available, fall back to async imitation (not expected in current carbone version)
    if (!tpl) return []
    const markers: string[] = []
    // preprocess each file's XML similar to render path (translate + clean) so markers recognized
    for (const f of tpl.files) {
      if (!f || typeof f.data !== 'string' || !/\.xml$/i.test(f.name)) continue
      const cleaned = carbonePreprocessor.preParseXML(f.data, {})
      carboneParser.findMarkers(cleaned, (_err: any, _clean: string, found: any[]) => {
        for (const mk of found) {
          const name = mk.name.replace(/^_root\./, '')
          // Accept markers starting with d. c. t. etc., we only return the raw marker token
          markers.push(name)
        }
      })
    }
    // Return unique field names after 'd.' prefix
    const dataFields = markers
      .filter(m => /^d\./.test(m))
      .map(m => m.slice(2).split(/[:(]/)[0]) // stop at formatter or structure
    return Array.from(new Set(dataFields)).sort()
  } catch (e: any) {
    log('warn', 'extractMarkersWithCarbone failed', { error: e.message })
    return []
  }
}
