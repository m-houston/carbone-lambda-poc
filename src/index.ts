// Structured logging helper
interface LogEntry { level: string; msg: string; [key: string]: any }
function log(level: string, msg: string, extra?: Record<string, any>) {
  const entry: LogEntry = { level, msg, timestamp: new Date().toISOString(), ...extra }
  console.log(JSON.stringify(entry))
}

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import tar from 'tar'
import { execFile } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

// LibreOffice layer initialization (expensive: do once per cold start)
const LO_ARCHIVE_BR = '/opt/lo.tar.br'
const LO_ARCHIVE_GZ = '/opt/lo.tar.gz'
const LO_EXTRACT_ROOT = '/tmp/libreoffice'
let loReady = false
let loExtractPromise: Promise<void> | null = null
let spawnPatched = false
function patchSofficeSpawn() {
  if (spawnPatched) return
  if (process.env.PATCH_SOFFICE === '0') return // patch enabled by default; set PATCH_SOFFICE=0 to disable
  const origSpawn = childProcess.spawn
  const userProfileArg = '-env:UserInstallation=file:///tmp/lo-profile'
  spawnPatched = true
  ;(childProcess as any).spawn = function patched(command: any, args?: any[], options?: any) {
    try {
      if (command && typeof command === 'string' && (command.endsWith('soffice') || command.endsWith('soffice.bin'))) {
        if (Array.isArray(args)) {
          // Ensure headless flags
          const needFlags = ['--headless','--nologo','--nolockcheck','--nofirststartwizard','--norestore']
          for (const f of needFlags) { if (!args.includes(f)) args.unshift(f) }
          // Ensure user profile arg present
            if (!args.some(a => typeof a === 'string' && a.startsWith('-env:UserInstallation='))) {
              args.unshift(userProfileArg)
            }
          // Move convert-to pdf:writer_pdf_Export earlier if plain pdf present
          const idx = args.findIndex(a => a === 'pdf')
          if (idx !== -1 && args[idx-1] === '--convert-to') {
            // Replace with explicit writer filter for reliability
            args[idx] = 'pdf:writer_pdf_Export'
          }
          if (process.env.DEBUG_RENDER === '1') {
            log('info','Patched soffice spawn',{ command, args })
          }
        }
        if (!options) options = {}
        options.env = { ...(options.env || process.env), HOME: '/tmp', FONTCONFIG_PATH: process.env.FONTCONFIG_PATH, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE }
      }
    } catch (e:any) {
      log('warn','Failed patching spawn call',{ error: e.message })
    }
    return origSpawn.call(childProcess, command, args as any, options)
  }
  log('info','Soffice spawn patch active',{ userProfileArg })
}
async function ensureLibreOfficeExtracted() {
  if (process.env.SKIP_CONVERT === '1') return
  if (loReady) return
  if (loExtractPromise) return loExtractPromise
  loExtractPromise = (async () => {
    try {
      // Already extracted?
      if (fs.existsSync(path.join(LO_EXTRACT_ROOT, 'instdir', 'program', 'soffice')) ||
          fs.existsSync(path.join(LO_EXTRACT_ROOT, 'instdir', 'program', 'soffice.bin'))) {
        addLibreOfficeToPath()
        patchSofficeSpawn()
        loReady = true
        return
      }
      const archivePath = fs.existsSync(LO_ARCHIVE_BR) ? LO_ARCHIVE_BR : (fs.existsSync(LO_ARCHIVE_GZ) ? LO_ARCHIVE_GZ : null)
      if (!archivePath) {
        log('warn', 'LibreOffice archive not found in layer path; skipping extraction (likely local dev)')
        return
      }
      const start = Date.now()
      fs.mkdirSync(LO_EXTRACT_ROOT, { recursive: true })
      const archiveBuffer = fs.readFileSync(archivePath)
      let tarBuffer: Buffer
      if (archivePath.endsWith('.br')) {
        tarBuffer = zlib.brotliDecompressSync(archiveBuffer)
      } else if (archivePath.endsWith('.gz')) {
        tarBuffer = zlib.gunzipSync(archiveBuffer)
      } else {
        throw new Error('Unsupported LibreOffice archive format')
      }
      const tmpTarPath = path.join('/tmp', `lo-${Date.now()}.tar`)
      fs.writeFileSync(tmpTarPath, tarBuffer)
      try {
        await tar.x({ file: tmpTarPath, cwd: LO_EXTRACT_ROOT })
      } finally {
        try { fs.unlinkSync(tmpTarPath) } catch { /* ignore */ }
      }
      addLibreOfficeToPath()
      patchSofficeSpawn()
      loReady = true
      const durationMs = Date.now() - start
      log('info', 'LibreOffice extracted (JS tar)', { durationMs, archivePath, size: tarBuffer.length })
    } catch (err: any) {
      log('error', 'LibreOffice extraction failed (JS tar)', { error: err?.message })
    }
  })()
  return loExtractPromise
}
function addLibreOfficeToPath() {
  const candidatePaths = [
    path.join(LO_EXTRACT_ROOT, 'instdir', 'program'), // after extraction
    '/opt/instdir/program', // some layer variants may extract here
    '/opt/libreoffice/program' // legacy path (if pre-extracted layer variant)
  ]
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      if (!process.env.PATH?.includes(p)) {
        process.env.PATH = `${p}:${process.env.PATH || ''}`
      }
      try { ensureSofficeWrapper(p) } catch (e:any) { log('warn','Failed to ensure soffice wrapper',{ error: e.message }) }
      patchSofficeSpawn()
      break
    }
  }
}

function ensureSofficeWrapper(programDir: string) {
  // Create wrappers or symlinks named "soffice" and "libreoffice" if only soffice.bin exists.
  const binPath = path.join(programDir, 'soffice.bin')
  const targets = [
    { name: 'soffice', path: path.join(programDir, 'soffice') },
    { name: 'libreoffice', path: path.join(programDir, 'libreoffice') }
  ]
  if (fs.existsSync(binPath)) {
    for (const t of targets) {
      if (!fs.existsSync(t.path)) {
        try {
          try {
            fs.symlinkSync(binPath, t.path)
            log('info', `Created ${t.name} symlink`, { scriptPath: t.path, target: binPath })
          } catch {
            fs.writeFileSync(t.path, `#!/bin/sh\nexec \"${binPath}\" \"$@\"\n`)
            fs.chmodSync(t.path, 0o755)
            log('info', `Created ${t.name} wrapper script`, { scriptPath: t.path })
          }
        } catch (e:any) {
          log('warn', `Unable to create ${t.name} wrapper`, { error: e.message })
        }
      }
    }
  }
  // Also ensure a /tmp/bin path early in PATH with symlinks for resilience.
  try {
    const tmpBin = '/tmp/bin'
    fs.mkdirSync(tmpBin, { recursive: true })
    for (const t of targets) {
      const tmpLink = path.join(tmpBin, t.name)
      if (fs.existsSync(binPath) && !fs.existsSync(tmpLink)) {
        try {
          fs.symlinkSync(binPath, tmpLink)
          log('info', `Created /tmp/bin/${t.name} symlink`, { target: binPath })
        } catch (e:any) {
          log('warn', `Failed to create /tmp/bin/${t.name} symlink`, { error: e.message })
        }
      }
    }
    if (!process.env.PATH?.startsWith(tmpBin)) {
      process.env.PATH = `${tmpBin}:${process.env.PATH || ''}`
    }
  } catch (e:any) {
    log('warn','Failed preparing /tmp/bin for office binaries',{ error: e.message })
  }
  if (process.env.DEBUG_RENDER === '1') {
    try {
      const listing = fs.readdirSync(programDir)
      log('info','Program dir listing',{ programDir, listing })
    } catch {/* ignore */}
  }
}

// Skip extraction on import; we'll perform it during warmup to allow async
// if (process.env.SKIP_CONVERT !== '1') { extractLibreOfficeIfNeeded() }

// Template path (copied into package/templates by build script)
const TEMPLATE_PATH = path.join(__dirname, 'templates', 'letter-template-nhs-notify_.docx')

let warmupPromise: Promise<void> | null = null
async function warmup() {
  if (warmupPromise) return warmupPromise
  warmupPromise = (async () => {
    await ensureLibreOfficeExtracted()
    prepareFontConfig()
    if (process.env.SKIP_CONVERT !== '1' && !loReady) {
      throw new Error('LibreOffice not available after extraction attempt')
    }
    if (!fs.existsSync(TEMPLATE_PATH)) {
      throw new Error(`Template not found at ${TEMPLATE_PATH}`)
    }
    // Load carbone only after LO extraction & PATH manipulation
    const carbone = getCarbone()
    let carboneVersion = (carbone as any).version || 'unknown'
    try {
      const pkgPath = require.resolve('carbone/package.json', { paths: [process.cwd()] })
      const pkgRaw = fs.readFileSync(pkgPath, 'utf8')
      const pkg = JSON.parse(pkgRaw)
      if (pkg?.version) carboneVersion = pkg.version
    } catch { /* ignore */ }
    const sofficePath = findSofficeBinary()
    log('info', 'Warmup complete', { templateSize: fs.statSync(TEMPLATE_PATH).size, carboneVersion, loReady, sofficeFound: !!sofficePath, sofficePath })
    if (process.env.DEBUG_RENDER === '1' && sofficePath) {
      try {
        const { stdout } = await execFileAsync(sofficePath, ['--version']).catch(()=>({ stdout: 'n/a'}))
        log('info','Soffice version probe',{ stdout })
      } catch {/* ignore */}
    }
  })()
  return warmupPromise
}

// Kick off warmup during module initialization so the first invocation is faster
const _warmupInit = warmup().catch(err => { log('error', 'Warmup failed', { error: err?.message }) })

interface RequestBody { data: Record<string, any> }
interface ParseResult { data: Record<string, any>; defaultUsed: boolean }
function buildDefaultData() {
  return {
    example: 'default-render',
    generatedAt: new Date().toISOString()
  }
}
function parseRequestBody(event: APIGatewayProxyEventV2): ParseResult {
  const method = (event as any).requestContext?.http?.method || 'POST'
  if (method === 'GET') {
    return { data: {}, defaultUsed: false }
  }
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k,v])=>[k.toLowerCase(), v]))
  const contentType = headers['content-type'] || ''
  if (!event.body || event.body.trim().length === 0) {
    return { data: buildDefaultData(), defaultUsed: true }
  }
  let rawBody = event.body
  if (event.isBase64Encoded) rawBody = Buffer.from(rawBody, 'base64').toString('utf8')

  // Handle x-www-form-urlencoded submissions from health form
  if (contentType.includes('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(rawBody)
      const dataJson = params.get('dataJson') || params.get('data')
      if (dataJson && dataJson.trim().length > 0) {
        const parsed = JSON.parse(dataJson)
        if (parsed && typeof parsed === 'object' && 'data' in parsed) {
          const inner = (parsed as any).data
          if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
            return { data: inner, defaultUsed: false }
          }
        }
        // If structure not matching expected, but is an object, treat entire parsed object as data
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { data: parsed as Record<string, any>, defaultUsed: false }
        }
      }
      return { data: buildDefaultData(), defaultUsed: true }
    } catch {
      return { data: buildDefaultData(), defaultUsed: true }
    }
  }

  if (rawBody.trim().length === 0) {
    return { data: buildDefaultData(), defaultUsed: true }
  }
  let json: any
  try { json = JSON.parse(rawBody) } catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }) }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) throw Object.assign(new Error('Body must be a JSON object'), { statusCode: 400 })
  if (!('data' in json)) return { data: buildDefaultData(), defaultUsed: true }
  if (typeof json.data !== 'object' || json.data === null) throw Object.assign(new Error('"data" must be an object'), { statusCode: 400 })
  return { data: json.data, defaultUsed: false }
}

function findSofficeBinary() {
  const names = ['soffice', 'soffice.bin']
  const dirs = [
    path.join(LO_EXTRACT_ROOT, 'instdir', 'program'),
    '/opt/instdir/program',
    '/opt/libreoffice/program',
    ...(process.env.PATH || '').split(':')
  ]
  for (const d of dirs) {
    for (const n of names) {
      const pth = path.join(d, n)
      try { if (fs.existsSync(pth)) return pth } catch { /* ignore */ }
    }
  }
  return null
}

// Helper to safely serialize errors
function serializeError(err: any) {
  if (!err) return null
  return {
    message: err.message || String(err),
    stack: process.env.DEBUG_RENDER === '1' ? err.stack : undefined,
    name: err.name,
    code: (err as any).code,
    raw: typeof err === 'object' ? Object.keys(err).reduce((a,k)=>{(a as any)[k]=err[k];return a;},{} as any) : undefined
  }
}

let fontConfigReady = false
function prepareFontConfig() {
  if (fontConfigReady) return
  try {
    const candidateFontDirs = [
      path.join(LO_EXTRACT_ROOT,'instdir','share','fonts'),
      '/opt/libreoffice/share/fonts',
      '/opt/fonts',
      '/usr/share/fonts'
    ].filter(d => { try { return fs.existsSync(d) } catch { return false } })
    const fontConfigDir = '/tmp/fontconfig'
    const cacheDir = '/tmp/fontconfig-cache'
    fs.mkdirSync(fontConfigDir, { recursive: true })
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.mkdirSync('/tmp/fonts', { recursive: true })
    const fontsConfPath = path.join(fontConfigDir, 'fonts.conf')
    const xml = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  ${(candidateFontDirs.map(d=>`<dir>${d}</dir>`)).join('\n  ')}\n  <dir>/tmp/fonts</dir>\n  <cachedir>${cacheDir}</cachedir>\n  <config></config>\n</fontconfig>`
    fs.writeFileSync(fontsConfPath, xml)
    process.env.FONTCONFIG_PATH = fontConfigDir
    process.env.FONTCONFIG_FILE = fontsConfPath
    process.env.XDG_CACHE_HOME = '/tmp'
    process.env.XDG_CONFIG_HOME = '/tmp'
    process.env.HOME = process.env.HOME || '/tmp'
    fontConfigReady = true
    log('info','Fontconfig prepared',{ fontsConfPath, dirs: candidateFontDirs, cacheDir })
  } catch (e:any) {
    log('warn','Fontconfig preparation failed', { error: e.message })
  }
}

async function renderPdf(data: Record<string, any>): Promise<Buffer> {
  if (process.env.SKIP_CONVERT === '1') {
    const pdf = `%PDF-1.4\n1 0 obj<<>>endobj\n2 0 obj<< /Type /Page /Parent 3 0 R /MediaBox[0 0 200 200] /Contents 4 0 R >>endobj\n3 0 obj<< /Type /Pages /Kids[2 0 R] /Count 1 >>endobj\n4 0 obj<< /Length 44 >>stream\nBT /F1 12 Tf 10 100 Td (Local Test PDF) Tj ET\nendstream endobj\n5 0 obj<< /Type /Catalog /Pages 3 0 R >>endobj\nxref\n0 6\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000124 00000 n \n0000000179 00000 n \n0000000293 00000 n \ntrailer<< /Size 6 /Root 5 0 R >>\nstartxref\n352\n%%EOF`
    return Buffer.from(pdf, 'utf8')
  }
  prepareFontConfig()
  patchSofficeSpawn()
  const sofficePath = findSofficeBinary()
  if (!sofficePath) {
    log('warn','Soffice binary not found before render attempt',{ PATH: process.env.PATH })
  }
  if (process.env.ALWAYS_SOFFICE === '1') {
    return fallbackSofficePath(data, sofficePath)
  }
  let primaryError: any = null
  // Attempt explicit writer filter first (empirically more reliable in Lambda)
  try {
    log('info','Carbone convert attempt',{ convertTo: 'pdf:writer_pdf_Export' })
    const pdfBuf: Buffer = await carboneToPdf(data, { convertTo: 'pdf:writer_pdf_Export' })
    return pdfBuf
  } catch (err:any) {
    primaryError = err
    log('warn','Carbone convert failed',{ convertTo: 'pdf:writer_pdf_Export', error: serializeError(err) })
  }
  // Fallback to generic pdf filter second
  try {
    log('info','Carbone convert attempt',{ convertTo: 'pdf' })
    const pdfBuf: Buffer = await carboneToPdf(data, { convertTo: 'pdf' })
    log('info','Carbone generic pdf succeeded')
    return pdfBuf
  } catch (err2:any) {
    if (!primaryError) primaryError = err2
    if (err2?.code === 'ENOENT') {
      log('warn','Carbone generic pdf failed - ENOENT',{ PATH: process.env.PATH, error: serializeError(err2) })
    } else {
      log('warn','Carbone generic pdf failed',{ convertTo: 'pdf', error: serializeError(err2) })
    }
  }
  // Proceed to manual soffice CLI fallback.
  return fallbackSofficePath(data, sofficePath, primaryError)
}

function carboneToPdf(data: Record<string,any>, opts: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    getCarbone().render(TEMPLATE_PATH, data, opts, (err: any, result: any) => {
      if (err) return reject(err)
      if (!result) return reject(new Error('No result buffer returned by Carbone'))
      resolve(result as unknown as Buffer)
    })
  })
}

async function fallbackSofficePath(data: Record<string, any>, sofficePath: string | null, primaryError?: any): Promise<Buffer> {
  if (!sofficePath) {
    throw primaryError || new Error('Fallback requested but soffice binary not found')
  }
  let docxBuffer: Buffer
  try {
    docxBuffer = await new Promise((resolve, reject) => {
      getCarbone().render(TEMPLATE_PATH, data, {}, (err: any, res: any) => {
        if (err) return reject(err)
        if (!res) return reject(new Error('No DOCX result buffer'))
        resolve(res as unknown as Buffer)
      })
    })
    log('info','DOCX generated for fallback',{ size: docxBuffer.length })
  } catch(docGenErr:any) {
    log('error','DOCX generation for fallback failed',{ error: serializeError(docGenErr) })
    throw primaryError || docGenErr
  }
  const ts = Date.now()
  const base = `carbone-${ts}-${Math.random().toString(36).slice(2)}`
  const inputPath = path.join('/tmp', `${base}.docx`)
  const outDir = '/tmp'
  fs.writeFileSync(inputPath, docxBuffer)
  const profileDir = '/tmp/lo-profile'
  fs.mkdirSync(profileDir, { recursive: true })
  const userInstallationArg = `-env:UserInstallation=file://${profileDir}`
  const attempts = [
    { filter: 'pdf', args: ['--convert-to','pdf'] },
    { filter: 'pdf:writer_pdf_Export', args: ['--convert-to','pdf:writer_pdf_Export'] },
    { filter: 'pdf:writer_pdf_export', args: ['--convert-to','pdf:writer_pdf_export'] },
    { filter: 'pdf:writer_web_pdf_Export', args: ['--convert-to','pdf:writer_web_pdf_Export'] }
  ]
  let lastErr: any = null
  for (const attempt of attempts) {
    const args = ['--headless','--nologo','--nolockcheck','--nofirststartwizard','--norestore', userInstallationArg, ...attempt.args, '--outdir', outDir, inputPath]
    const execStart = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(sofficePath, args, { env: { ...process.env, HOME: '/tmp', FONTCONFIG_PATH: process.env.FONTCONFIG_PATH, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE }, timeout: 45000 }).catch(e => { throw e })
      log('info','Fallback soffice conversion executed',{ filter: attempt.filter, ms: Date.now()-execStart, stdout: process.env.DEBUG_RENDER==='1'?stdout:undefined, stderr: process.env.DEBUG_RENDER==='1'?stderr:undefined })
      const pdfPath = inputPath.replace(/\.docx$/i,'.pdf')
      if (!fs.existsSync(pdfPath)) throw new Error('Soffice reported success but PDF missing')
      const pdf = fs.readFileSync(pdfPath)
      try { fs.unlinkSync(inputPath) } catch{}
      try { fs.unlinkSync(pdfPath) } catch{}
      return pdf
    } catch (cliErr:any) {
      lastErr = cliErr
      log('warn','Fallback soffice attempt failed',{ filter: attempt.filter, error: serializeError(cliErr) })
    }
  }
  try { fs.unlinkSync(inputPath) } catch{}
  // Diagnostic: attempt simple txt conversion to see if soffice works at all
  if (process.env.DEBUG_RENDER === '1') {
    try {
      const diagTxt = '/tmp/diag-test.txt'
      fs.writeFileSync(diagTxt, 'Diagnostic test at ' + new Date().toISOString())
      const diagArgs = ['--headless','--nologo','--nolockcheck','--nofirststartwizard','--norestore', userInstallationArg,'--convert-to','pdf','--outdir','/tmp', diagTxt]
      const startDiag = Date.now()
      await execFileAsync(sofficePath, diagArgs, { env: { ...process.env, HOME: '/tmp', FONTCONFIG_PATH: process.env.FONTCONFIG_PATH, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE }, timeout: 30000 }).catch(e=>{ throw e })
      const diagPdf = diagTxt.replace(/\.txt$/,'.pdf')
      const diagExists = fs.existsSync(diagPdf)
      log('info','Diagnostic txt -> pdf attempt complete',{ ms: Date.now()-startDiag, diagPdfExists: diagExists })
      if (diagExists) { try { fs.unlinkSync(diagPdf) } catch{} }
      try { fs.unlinkSync(diagTxt) } catch{}
    } catch(diagErr:any) {
      log('warn','Diagnostic txt conversion failed',{ error: serializeError(diagErr) })
    }
  }
  throw primaryError || lastErr || new Error('All fallback soffice attempts failed')
}

export const handler = async (event: APIGatewayProxyEventV2, context: Context): Promise<APIGatewayProxyStructuredResultV2> => {
  const requestId = event.requestContext?.requestId || context.awsRequestId
  const method = (event as any).requestContext?.http?.method || 'POST'
  const start = Date.now()
  try {
    if (method === 'GET') {
      await warmup()
      const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>Carbone PDF Health</title><style>body{font-family:system-ui,Arial,sans-serif;margin:2rem;line-height:1.4}textarea{width:100%;font-family:monospace}fieldset{margin-top:1rem}iframe{width:100%;height:600px;border:1px solid #ccc;margin-top:1rem}</style></head><body><h1>Carbone PDF Render Lambda</h1><p>Status: <strong>ok</strong><br/>LibreOffice ready: <strong>${loReady}</strong><br/>Template present: <strong>${fs.existsSync(TEMPLATE_PATH)}</strong></p><p>Submit JSON below to render the template. Provide an object like: <code>{\"data\": { ...fields }}</code>. If you omit <code>data</code> or leave empty, default mock data is used.</p><form method="POST" action="/" enctype="application/x-www-form-urlencoded" target="_blank"><fieldset><legend>Render PDF</legend><textarea name="dataJson" rows="12">{\n  \"data\": {\n    \"example\": \"value\",\n    \"fullName\": \"Alice Dobbs\",\n    \"date\": \"${new Date().toISOString().substring(0,10)}\",\n    \"nhsNumber\": \"9990000000\"\n  }\n}</textarea><div style="margin-top:0.5rem;"><button type="submit">Render PDF (new tab)</button></div></fieldset></form><hr/><p><small>Default data logic active: empty / missing / malformed returns a fallback object.<br/>Built at: ${new Date().toISOString()}</small></p></body></html>`
      return {
        statusCode: 200,
        isBase64Encoded: false,
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
        body: html
      }
    }
    await warmup()
    const { data, defaultUsed } = parseRequestBody(event)
    log('info', 'Rendering start', { requestId, defaultUsed })
    const pdfBuffer = await renderPdf(data)
    const durationMs = Date.now() - start
    log('info', 'Rendering success', { requestId, durationMs, size: pdfBuffer.length, defaultUsed })
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="generated.pdf"'
      },
      body: pdfBuffer.toString('base64')
    }
  } catch (error: any) {
    const statusCode = error?.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500
    log('error', 'Rendering failed', { requestId, statusCode, error: error?.message, stack: process.env.DEBUG_RENDER==='1'?error?.stack:undefined })
    return {
      statusCode,
      isBase64Encoded: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: error?.message || 'Internal Server Error' })
    }
  }
}

// Defer requiring carbone until after LibreOffice path adjustments to avoid early "soffice not found" caching
let carboneMod: any = null
function getCarbone() {
  if (!carboneMod) {
    carboneMod = require('carbone')
  }
  return carboneMod
}
