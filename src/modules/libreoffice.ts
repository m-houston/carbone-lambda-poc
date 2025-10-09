/**
 * LibreOffice layer initialization and management
 */

import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import tar from 'tar'
import { log } from '../utils/logger.js'

// LibreOffice paths and configuration
const LO_ARCHIVE_BR = '/opt/lo.tar.br'
const LO_ARCHIVE_GZ = '/opt/lo.tar.gz'
const LO_EXTRACT_ROOT = '/tmp/libreoffice'

// State management
let loReady = false
let loExtractPromise: Promise<void> | null = null
let fontConfigReady = false

/**
 * Ensures LibreOffice is extracted and ready for use
 * @returns Promise that resolves when LibreOffice is ready
 */
export async function ensureLibreOfficeExtracted(): Promise<void> {
  if (process.env.SKIP_CONVERT === '1') return
  if (loReady) return
  if (loExtractPromise) return loExtractPromise

  loExtractPromise = extractLibreOffice()
  return loExtractPromise
}

/**
 * Internal function to handle LibreOffice extraction
 */
async function extractLibreOffice(): Promise<void> {
  try {
    // Check if already extracted
    if (fs.existsSync(path.join(LO_EXTRACT_ROOT, 'instdir', 'program', 'soffice')) ||
        fs.existsSync(path.join(LO_EXTRACT_ROOT, 'instdir', 'program', 'soffice.bin'))) {
      addLibreOfficeToPath()
      loReady = true
      return
    }

    // Find archive
    const archivePath = findLibreOfficeArchive()
    if (!archivePath) {
      log('warn', 'LibreOffice archive not found; skipping extraction (likely local)')
      return
    }

    const start = Date.now()
    fs.mkdirSync(LO_EXTRACT_ROOT, { recursive: true })

    // Read and decompress archive
    const buf = fs.readFileSync(archivePath)
    const tarBuffer = decompressArchive(buf, archivePath)

    // Extract to temporary location
    const tmpTar = path.join('/tmp', `lo-${Date.now()}.tar`)
    fs.writeFileSync(tmpTar, tarBuffer)

    try {
      await tar.x({ file: tmpTar, cwd: LO_EXTRACT_ROOT })
    } finally {
      try {
        fs.unlinkSync(tmpTar)
      } catch {
        // Ignore cleanup failures
      }
    }

    addLibreOfficeToPath()
    loReady = true

    log('info', 'LibreOffice extracted', {
      durationMs: Date.now() - start,
      size: tarBuffer.length,
      archivePath
    })
  } catch (e: any) {
    log('error', 'LibreOffice extraction failed', { error: e.message })
    throw e
  }
}

/**
 * Finds the LibreOffice archive file
 */
function findLibreOfficeArchive(): string | null {
  if (fs.existsSync(LO_ARCHIVE_BR)) return LO_ARCHIVE_BR
  if (fs.existsSync(LO_ARCHIVE_GZ)) return LO_ARCHIVE_GZ
  return null
}

/**
 * Decompresses the LibreOffice archive based on file extension
 */
function decompressArchive(buf: Buffer, archivePath: string): Buffer {
  if (archivePath.endsWith('.br')) {
    return zlib.brotliDecompressSync(buf)
  } else if (archivePath.endsWith('.gz')) {
    return zlib.gunzipSync(buf)
  } else {
    throw new Error('Unsupported LO archive format')
  }
}

/**
 * Adds LibreOffice program directory to PATH and sets up wrappers
 */
function addLibreOfficeToPath(): void {
  const candidatePaths = [
    path.join(LO_EXTRACT_ROOT, 'instdir', 'program'),
    '/opt/instdir/program',
    '/opt/libreoffice/program'
  ]

  for (const programPath of candidatePaths) {
    if (fs.existsSync(programPath)) {
      if (!process.env.PATH?.includes(programPath)) {
        process.env.PATH = `${programPath}:${process.env.PATH || ''}`
      }
      
      try {
        ensureSofficeWrapper(programPath)
      } catch {
        // Ignore wrapper creation failures
      }
      break
    }
  }
}

/**
 * Creates soffice wrapper script or symlink if needed
 */
function ensureSofficeWrapper(programDir: string): void {
  const binPath = path.join(programDir, 'soffice.bin')
  const scriptPath = path.join(programDir, 'soffice')

  if (fs.existsSync(binPath) && !fs.existsSync(scriptPath)) {
    try {
      // Try symlink first
      try {
        fs.symlinkSync(binPath, scriptPath)
        log('info', 'Created soffice symlink', { scriptPath, target: binPath })
      } catch {
        // Fall back to wrapper script
        fs.writeFileSync(scriptPath, `#!/bin/sh\nexec "${binPath}" "$@"\n`)
        fs.chmodSync(scriptPath, 0o755)
        log('info', 'Created soffice wrapper script', { scriptPath })
      }
    } catch (e: any) {
      log('warn', 'Unable to create soffice wrapper', { error: e.message })
    }
  }

  // Create /tmp/bin symlink for fallback
  setupTmpBinSymlink(binPath)
}

/**
 * Sets up /tmp/bin symlink for soffice
 */
function setupTmpBinSymlink(binPath: string): void {
  try {
    const tmpBin = '/tmp/bin'
    fs.mkdirSync(tmpBin, { recursive: true })
    const tmpSoffice = path.join(tmpBin, 'soffice')

    if (fs.existsSync(binPath) && !fs.existsSync(tmpSoffice)) {
      try {
        fs.symlinkSync(binPath, tmpSoffice)
        log('info', 'Created /tmp/bin/soffice symlink', { target: binPath })
      } catch (e: any) {
        log('warn', 'Failed to create /tmp/bin/soffice symlink', { error: e.message })
      }
    }

    if (!process.env.PATH?.startsWith(tmpBin)) {
      process.env.PATH = `${tmpBin}:${process.env.PATH || ''}`
    }
  } catch (e: any) {
    log('warn', 'Failed prepping /tmp/bin', { error: e.message })
  }
}

/**
 * Finds the soffice binary in the system
 * @returns Path to soffice binary or null if not found
 */
export function findSofficeBinary(): string | null {
  const names = ['soffice', 'soffice.bin']
  const dirs = [
    path.join(LO_EXTRACT_ROOT, 'instdir', 'program'),
    '/opt/instdir/program',
    '/opt/libreoffice/program',
    ...(process.env.PATH || '').split(':')
  ]

  for (const dir of dirs) {
    for (const name of names) {
      const fullPath = path.join(dir, name)
      try {
        if (fs.existsSync(fullPath)) {
          return fullPath
        }
      } catch {
        // Ignore access errors
      }
    }
  }

  return null
}

/**
 * Prepares fontconfig for LibreOffice
 */
export function prepareFontConfig(): void {
  if (fontConfigReady) return

  try {
    const candidateDirs = [
      path.join(LO_EXTRACT_ROOT, 'instdir', 'share', 'fonts'),
      '/opt/libreoffice/share/fonts',
      '/opt/fonts',
      '/usr/share/fonts'
    ].filter(dir => {
      try {
        return fs.existsSync(dir)
      } catch {
        return false
      }
    })

    const fontConfigDir = '/tmp/fontconfig'
    const cacheDir = '/tmp/fontconfig-cache'

    fs.mkdirSync(fontConfigDir, { recursive: true })
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.mkdirSync('/tmp/fonts', { recursive: true })

    const confPath = path.join(fontConfigDir, 'fonts.conf')
    const xml = createFontConfigXml(candidateDirs, cacheDir)
    fs.writeFileSync(confPath, xml)

    // Set environment variables
    process.env.FONTCONFIG_PATH = fontConfigDir
    process.env.FONTCONFIG_FILE = confPath
    process.env.XDG_CACHE_HOME = '/tmp'
    process.env.XDG_CONFIG_HOME = '/tmp'
    process.env.HOME = process.env.HOME || '/tmp'

    fontConfigReady = true

    log('info', 'Fontconfig prepared', {
      confPath,
      dirs: candidateDirs,
      cacheDir
    })
  } catch (e: any) {
    log('warn', 'Fontconfig preparation failed', { error: e.message })
  }
}

/**
 * Creates fontconfig XML configuration
 */
function createFontConfigXml(fontDirs: string[], cacheDir: string): string {
  const dirEntries = fontDirs.map(dir => `  <dir>${dir}</dir>`).join('\n')
  
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${dirEntries}
  <dir>/tmp/fonts</dir>
  <cachedir>${cacheDir}</cachedir>
  <config></config>
</fontconfig>`
}

/**
 * Returns whether LibreOffice is ready for use
 */
export function isLibreOfficeReady(): boolean {
  return loReady
}