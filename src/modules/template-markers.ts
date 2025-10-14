/**
 * Template discovery and marker extraction utilities
 */
import fs from 'node:fs'
import path from 'node:path'
import AdmZip from 'adm-zip'
import { log } from '../utils/logger'

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
    // Primary (alongside compiled module files in package or src)
    const candidates = [
        path.join(__dirname, 'templates'),                                 // e.g. dist/modules/templates or package/modules/templates (if copied)
        path.join(__dirname, '..', 'modules', 'templates'),                // fallback if compiled path differs
        path.join(process.cwd(), 'templates'),                             // root-level templates (development & tests)
        path.join(process.cwd(), 'src', 'modules', 'templates')            // source tree location
    ]
    for (const dir of candidates) {
        try {
            if (fs.existsSync(dir) && fs.readdirSync(dir).some(f => f.toLowerCase().endsWith('.docx'))) {
                return dir
            }
        } catch { }
    }
    // Fallback to first candidate even if empty (preserves previous behavior)
    return candidates[0]
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

    const markers = extractMarkersFromDocx(templatePath)
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
 * Extract markers by unzipping DOCX (ZIP) and scanning XML files with regex patterns approximating Carbone markers.
 * We focus on data markers that reference the data object (typically {d.field}, {d.user.name}, etc.).
 * Returns unique, sorted marker paths without the leading 'd.'
 */
function extractMarkersFromDocx(templatePath: string): string[] {
    try {
        const zip = new AdmZip(templatePath)
        const entries = zip.getEntries()
        const dataMarkers: Set<string> = new Set()

        const debugLevel = process.env.DEBUG_MARKERS

        for (const entry of entries) {
            if (!/\.xml$/i.test(entry.entryName)) continue
            // We restrict primarily to word/ directory but allow others just in case
            const isWord = entry.entryName.startsWith('word/')
            if (!isWord) continue
            const contentBuf = entry.getData()
            let xml = ''
            try {
                xml = contentBuf.toString('utf8')
            } catch { continue }
            if (debugLevel === '2') {
                log('debug', 'xml-scan', { file: entry.entryName, size: xml.length })
            }

            const directRe = /\{([^{]+?)\}/g
            let m: RegExpExecArray | null
            while ((m = directRe.exec(xml)) !== null) {
                const rawPath = m[1]
                if (rawPath) {
                    const path = normalizePath(rawPath);
                    if (!path.startsWith('d.')) continue

                    dataMarkers.add(path.replace(/^d\./, ''))
                    if (debugLevel === '2') {
                        log('debug', 'marker', { file: entry.entryName, path })
                    }
                }
            }
        }

        const markers = Array.from(dataMarkers).filter(Boolean).sort()
        if (debugLevel === '1') {
            log('debug', 'marker-debug', { templatePath, markers })
        }
        return markers
    } catch (e: any) {
        log('warn', 'extractMarkers unzip failed', { error: e.message })
        return []
    }
}

function normalizePath(p: string): string {
    // Remove any array-style indices like users[0].name -> users.name (we only care about field names)
    return p
        // strip any embedded XML tags that may have been captured across DOCX text runs
        .replace(/<[^>]+>/g, '')
        // remove array indices
        .replace(/\[[^\]]*]/g, '')
        // collapse whitespace
        .replace(/\s+/g, '')
        // collapse multiple dots
        .replace(/\.+/g, '.')
        // trim leading/trailing dots
        .replace(/^\./, '')
        .replace(/\.$/, '')
}
