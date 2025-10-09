/**
 * PDF conversion using Carbone and LibreOffice
 */

import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import carbone from 'carbone'
import { log, serializeError } from '../utils/logger.js'
import { findSofficeBinary, prepareFontConfig } from './libreoffice.js'

const execFileAsync = promisify(execFile)

// Template configuration
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'letter-template-nhs-notify_.docx')

/**
 * Interface for Carbone render options
 */
interface CarboneOptions {
  convertTo?: string
}

/**
 * Renders a PDF from template data
 * @param data - Data to populate the template
 * @returns Promise resolving to PDF buffer
 */
export async function renderPdf(data: Record<string, any>): Promise<Buffer> {
  if (process.env.SKIP_CONVERT === '1') {
    return createPlaceholderPdf()
  }

  prepareFontConfig()
  const sofficePath = findSofficeBinary()

  if (!sofficePath) {
    log('warn', 'Soffice binary not found before Carbone attempt', {
      PATH: process.env.PATH
    })
  }

  // If forced to use soffice fallback
  if (process.env.ALWAYS_SOFFICE === '1') {
    return fallbackSofficePath(data, sofficePath)
  }

  // Try primary Carbone conversion
  let primaryError: any = null
  try {
    return await carboneToBuf(data, { convertTo: 'pdf' })
  } catch (e: any) {
    primaryError = e
    if (e?.code === 'ENOENT') {
      log('warn', 'Primary carbone pdf failed ENOENT', {
        error: serializeError(e),
        PATH: process.env.PATH
      })
    } else {
      log('warn', 'Primary carbone pdf failed', { error: serializeError(e) })
    }
  }

  // Try alternate Carbone conversion
  try {
    const result = await carboneToBuf(data, { convertTo: 'pdf:writer_pdf_Export' })
    log('info', 'Alternate carbone writer_pdf_Export succeeded')
    return result
  } catch (e2: any) {
    if (!primaryError) primaryError = e2
    log('warn', 'Alternate carbone writer_pdf_Export failed', {
      error: serializeError(e2),
      PATH: process.env.PATH
    })
  }

  // Fall back to direct soffice conversion
  return fallbackSofficePath(data, sofficePath, primaryError)
}

/**
 * Converts data to buffer using Carbone
 * @param data - Template data
 * @param options - Carbone options
 * @returns Promise resolving to converted buffer
 */
function carboneToBuf(data: Record<string, any>, options: CarboneOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    carbone.render(TEMPLATE_PATH, data, options, (err, result) => {
      if (err) return reject(err)
      if (!result) return reject(new Error('No result from Carbone'))
      resolve(result as unknown as Buffer)
    })
  })
}

/**
 * Fallback conversion using direct soffice execution
 * @param data - Template data
 * @param sofficePath - Path to soffice binary
 * @param primaryError - Previous error to throw if this also fails
 * @returns Promise resolving to PDF buffer
 */
async function fallbackSofficePath(
  data: Record<string, any>,
  sofficePath: string | null,
  primaryError?: any
): Promise<Buffer> {
  if (!sofficePath) {
    throw primaryError || new Error('Fallback requested but soffice binary not found')
  }

  // First generate DOCX
  let docx: Buffer
  try {
    docx = await carboneToBuf(data, {})
    log('info', 'DOCX generated for fallback', { size: docx.length })
  } catch (e: any) {
    log('error', 'DOCX generation failed for fallback', { error: serializeError(e) })
    throw primaryError || e
  }

  // Prepare temporary files
  const timestamp = Date.now()
  const randomId = Math.random().toString(36).slice(2)
  const base = `carbone-${timestamp}-${randomId}`
  const inputPath = path.join('/tmp', `${base}.docx`)
  const outDir = '/tmp'

  fs.writeFileSync(inputPath, docx)

  // Set up LibreOffice profile
  const profileDir = '/tmp/lo-profile'
  fs.mkdirSync(profileDir, { recursive: true })
  const userInstallationArg = `-env:UserInstallation=file://${profileDir}`

  // Try different conversion filters
  const conversionAttempts = [
    { filter: 'pdf', args: ['--convert-to', 'pdf'] },
    { filter: 'pdf:writer_pdf_Export', args: ['--convert-to', 'pdf:writer_pdf_Export'] },
    { filter: 'pdf:writer_pdf_export', args: ['--convert-to', 'pdf:writer_pdf_export'] },
    { filter: 'pdf:writer_web_pdf_Export', args: ['--convert-to', 'pdf:writer_web_pdf_Export'] }
  ]

  let lastError: any = null

  for (const attempt of conversionAttempts) {
    const args = [
      '--headless',
      '--nologo',
      '--nolockcheck',
      '--nofirststartwizard',
      '--norestore',
      userInstallationArg,
      ...attempt.args,
      '--outdir',
      outDir,
      inputPath
    ]

    const start = Date.now()

    try {
      const { stdout, stderr } = await execFileAsync(sofficePath, args, {
        env: {
          ...process.env,
          HOME: '/tmp',
          FONTCONFIG_PATH: process.env.FONTCONFIG_PATH,
          FONTCONFIG_FILE: process.env.FONTCONFIG_FILE
        },
        timeout: 45000
      })

      log('info', 'Fallback soffice conversion executed', {
        filter: attempt.filter,
        ms: Date.now() - start,
        stdout: process.env.DEBUG_RENDER === '1' ? stdout : undefined,
        stderr: process.env.DEBUG_RENDER === '1' ? stderr : undefined
      })

      const pdfPath = inputPath.replace(/\.docx$/i, '.pdf')
      if (!fs.existsSync(pdfPath)) {
        throw new Error('PDF output missing after soffice conversion')
      }

      const pdf = fs.readFileSync(pdfPath)

      // Cleanup
      try { fs.unlinkSync(inputPath) } catch {}
      try { fs.unlinkSync(pdfPath) } catch {}

      return pdf
    } catch (err: any) {
      lastError = err
      log('warn', 'Fallback soffice attempt failed', {
        filter: attempt.filter,
        error: serializeError(err)
      })
    }
  }

  // Cleanup on failure
  try { fs.unlinkSync(inputPath) } catch {}

  throw primaryError || lastError || new Error('All fallback soffice attempts failed')
}

/**
 * Creates a placeholder PDF for testing
 * @returns Buffer containing a minimal PDF
 */
function createPlaceholderPdf(): Buffer {
  const pdfContent = `%PDF-1.4
1 0 obj<<>>endobj
2 0 obj<< /Type /Page /Parent 3 0 R /MediaBox[0 0 200 200] /Contents 4 0 R >>endobj
3 0 obj<< /Type /Pages /Kids[2 0 R] /Count 1 >>endobj
4 0 obj<< /Length 44 >>stream
BT /F1 12 Tf 10 100 Td (Local Test PDF) Tj ET
endstream endobj
5 0 obj<< /Type /Catalog /Pages 3 0 R >>endobj
xref
0 6
0000000000 65535 f 
0000000010 00000 n 
0000000053 00000 n 
0000000124 00000 n 
0000000179 00000 n 
0000000293 00000 n 
trailer<< /Size 6 /Root 5 0 R >>
startxref
352
%%EOF`

  return Buffer.from(pdfContent, 'utf8')
}

/**
 * Validates that the template file exists
 * @returns True if template exists
 */
export function validateTemplate(): boolean {
  return fs.existsSync(TEMPLATE_PATH)
}

/**
 * Gets template file size for diagnostics
 * @returns Template file size in bytes
 */
export function getTemplateSize(): number {
  try {
    return fs.statSync(TEMPLATE_PATH).size
  } catch {
    return 0
  }
}

/**
 * Gets the template path
 */
export function getTemplatePath(): string {
  return TEMPLATE_PATH
}