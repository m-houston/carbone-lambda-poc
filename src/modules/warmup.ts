/**
 * Application warmup and initialization
 */

import fs from 'node:fs'
import carbone from 'carbone'
import { log } from '../utils/logger.js'
import { ensureLibreOfficeExtracted, isLibreOfficeReady, findSofficeBinary } from './libreoffice.js'
import { validateTemplate, getTemplateSize } from './conversion.js'

let warmupPromise: Promise<void> | null = null

/**
 * Performs application warmup including LibreOffice extraction and validation
 * @returns Promise that resolves when warmup is complete
 */
export async function warmup(): Promise<void> {
  if (warmupPromise) return warmupPromise

  warmupPromise = performWarmup()
  return warmupPromise
}

/**
 * Internal function to perform the actual warmup
 */
async function performWarmup(): Promise<void> {
  try {
    // Extract LibreOffice if needed
    await ensureLibreOfficeExtracted()

    // Validate LibreOffice is available (unless skipping conversion)
    if (process.env.SKIP_CONVERT !== '1' && !isLibreOfficeReady()) {
      throw new Error('LibreOffice not available after extraction')
    }

    // Validate template exists
    if (!validateTemplate()) {
      throw new Error('Template missing')
    }

    // Get Carbone version for diagnostics
    const carboneVersion = getCarboneVersion()

    // Find soffice binary
    const sofficePath = findSofficeBinary()

    log('info', 'Warmup complete', {
      templateSize: getTemplateSize(),
      carboneVersion,
      loReady: isLibreOfficeReady(),
      sofficeFound: !!sofficePath,
      sofficePath
    })
  } catch (error: any) {
    log('error', 'Warmup failed', { error: error.message })
    throw error
  }
}

/**
 * Gets the Carbone version for diagnostics
 */
function getCarboneVersion(): string {
  let version = (carbone as any).version || 'unknown'
  
  try {
    const pkgPath = require.resolve('carbone/package.json', { paths: [process.cwd()] })
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    version = pkg.version || version
  } catch {
    // Ignore errors, use default version
  }
  
  return version
}

// Start warmup immediately when module is loaded
const warmupStart = warmup().catch(e => 
  log('error', 'Module-level warmup failed', { error: e.message })
)

/**
 * Ensures warmup has completed
 * @returns Promise that resolves when warmup is done
 */
export async function ensureWarmup(): Promise<void> {
  await warmupStart
  return warmup()
}