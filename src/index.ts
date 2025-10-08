import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Context } from 'aws-lambda'
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import carbone from 'carbone'
import tar from 'tar'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

// Structured logging helper
interface LogEntry { level: string; msg: string; [key: string]: any }
function log(level: string, msg: string, extra?: Record<string, any>) {
  const entry: LogEntry = { level, msg, timestamp: new Date().toISOString(), ...extra }
  console.log(JSON.stringify(entry))
}

// LibreOffice layer initialization
const LO_ARCHIVE_BR = '/opt/lo.tar.br'
const LO_ARCHIVE_GZ = '/opt/lo.tar.gz'
const LO_EXTRACT_ROOT = '/tmp/libreoffice'
let loReady = false
let loExtractPromise: Promise<void> | null = null
async function ensureLibreOfficeExtracted() {
  if (process.env.SKIP_CONVERT === '1') return
  if (loReady) return
  if (loExtractPromise) return loExtractPromise
  loExtractPromise = (async () => {
    try {
      // Already there?
      if (fs.existsSync(path.join(LO_EXTRACT_ROOT, 'instdir', 'program', 'soffice')) ||
          fs.existsSync(path.join(LO_EXTRACT_ROOT, 'instdir', 'program', 'soffice.bin'))) {
        addLibreOfficeToPath()
        loReady = true
        return
      }
      const archivePath = fs.existsSync(LO_ARCHIVE_BR) ? LO_ARCHIVE_BR : (fs.existsSync(LO_ARCHIVE_GZ) ? LO_ARCHIVE_GZ : null)
      if (!archivePath) {
        log('warn','LibreOffice archive not found; skipping extraction (likely local)')
        return
      }
      const start = Date.now()
      fs.mkdirSync(LO_EXTRACT_ROOT, { recursive: true })
      const buf = fs.readFileSync(archivePath)
      let tarBuffer: Buffer
      if (archivePath.endsWith('.br')) tarBuffer = zlib.brotliDecompressSync(buf)
      else if (archivePath.endsWith('.gz')) tarBuffer = zlib.gunzipSync(buf)
      else throw new Error('Unsupported LO archive format')
      const tmpTar = path.join('/tmp', `lo-${Date.now()}.tar`)
      fs.writeFileSync(tmpTar, tarBuffer)
      try { await tar.x({ file: tmpTar, cwd: LO_EXTRACT_ROOT }) } finally { try { fs.unlinkSync(tmpTar) } catch {} }
      addLibreOfficeToPath()
      loReady = true
      log('info','LibreOffice extracted',{ durationMs: Date.now()-start, size: tarBuffer.length, archivePath })
    } catch (e:any) {
      log('error','LibreOffice extraction failed',{ error: e.message })
    }
  })()
  return loExtractPromise
}
function addLibreOfficeToPath() {
  const candidatePaths = [
    path.join(LO_EXTRACT_ROOT,'instdir','program'),
    '/opt/instdir/program',
    '/opt/libreoffice/program'
  ]
  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      if (!process.env.PATH?.includes(p)) process.env.PATH = `${p}:${process.env.PATH || ''}`
      try { ensureSofficeWrapper(p) } catch {}
      break
    }
  }
}
function ensureSofficeWrapper(programDir: string) {
  const binPath = path.join(programDir,'soffice.bin')
  const scriptPath = path.join(programDir,'soffice')
  if (fs.existsSync(binPath) && !fs.existsSync(scriptPath)) {
    try {
      try { fs.symlinkSync(binPath, scriptPath); log('info','Created soffice symlink',{ scriptPath, target: binPath }) }
      catch { fs.writeFileSync(scriptPath, `#!/bin/sh\nexec "${binPath}" "$@"\n`); fs.chmodSync(scriptPath,0o755); log('info','Created soffice wrapper script',{ scriptPath }) }
    } catch (e:any) { log('warn','Unable to create soffice wrapper',{ error: e.message }) }
  }
  try {
    const tmpBin = '/tmp/bin'
    fs.mkdirSync(tmpBin,{ recursive:true })
    const tmpSoffice = path.join(tmpBin,'soffice')
    if (fs.existsSync(binPath) && !fs.existsSync(tmpSoffice)) {
      try { fs.symlinkSync(binPath, tmpSoffice); log('info','Created /tmp/bin/soffice symlink',{ target: binPath }) } catch (e:any) { log('warn','Failed to create /tmp/bin/soffice symlink',{ error: e.message }) }
    }
    if (!process.env.PATH?.startsWith(tmpBin)) process.env.PATH = `${tmpBin}:${process.env.PATH || ''}`
  } catch (e:any) { log('warn','Failed prepping /tmp/bin',{ error: e.message }) }
}

// Template path
const TEMPLATE_PATH = path.join(__dirname,'templates','letter-template-nhs-notify_.docx')

let warmupPromise: Promise<void> | null = null
async function warmup() {
  if (warmupPromise) return warmupPromise
  warmupPromise = (async () => {
    await ensureLibreOfficeExtracted()
    prepareFontConfig()
    if (process.env.SKIP_CONVERT !== '1' && !loReady) throw new Error('LibreOffice not available after extraction')
    if (!fs.existsSync(TEMPLATE_PATH)) throw new Error('Template missing')
    let carboneVersion = (carbone as any).version || 'unknown'
    try {
      const pkgPath = require.resolve('carbone/package.json', { paths: [process.cwd()] })
      carboneVersion = JSON.parse(fs.readFileSync(pkgPath,'utf8')).version || carboneVersion
    } catch {}
    const sofficePath = findSofficeBinary()
    log('info','Warmup complete',{ templateSize: fs.statSync(TEMPLATE_PATH).size, carboneVersion, loReady, sofficeFound: !!sofficePath, sofficePath })
  })()
  return warmupPromise
}
const _warm = warmup().catch(e=>log('error','Warmup failed',{ error: e.message }))

// Request parsing & defaults
interface ParseResult { data: Record<string,any>; defaultUsed: boolean }
function buildDefaultData() { return { example: 'default-render', generatedAt: new Date().toISOString() } }
function parseRequestBody(event: APIGatewayProxyEventV2): ParseResult {
  const method = (event as any).requestContext?.http?.method || 'POST'
  if (method === 'GET') return { data: {}, defaultUsed: false }
  const headers = Object.fromEntries(Object.entries(event.headers||{}).map(([k,v])=>[k.toLowerCase(),v]))
  const ct = headers['content-type'] || ''
  if (!event.body || event.body.trim()==='') return { data: buildDefaultData(), defaultUsed: true }
  let raw = event.body
  if (event.isBase64Encoded) raw = Buffer.from(raw,'base64').toString('utf8')
  if (ct.includes('application/x-www-form-urlencoded')) {
    try {
      const params = new URLSearchParams(raw)
      const dataJson = params.get('dataJson') || params.get('data')
      if (dataJson) {
        const parsed = JSON.parse(dataJson)
        if (parsed && typeof parsed === 'object') {
          if ('data' in parsed && parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) return { data: parsed.data, defaultUsed: false }
          if (!Array.isArray(parsed)) return { data: parsed, defaultUsed: false }
        }
      }
      return { data: buildDefaultData(), defaultUsed: true }
    } catch { return { data: buildDefaultData(), defaultUsed: true } }
  }
  let json: any
  try { json = JSON.parse(raw) } catch { throw Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }) }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw Object.assign(new Error('Body must be an object'), { statusCode: 400 })
  if (!('data' in json)) return { data: buildDefaultData(), defaultUsed: true }
  if (!json.data || typeof json.data !== 'object' || Array.isArray(json.data)) throw Object.assign(new Error('"data" must be an object'), { statusCode: 400 })
  return { data: json.data, defaultUsed: false }
}

function findSofficeBinary() {
  const names = ['soffice','soffice.bin']
  const dirs = [
    path.join(LO_EXTRACT_ROOT,'instdir','program'),
    '/opt/instdir/program',
    '/opt/libreoffice/program',
    ...(process.env.PATH||'').split(':')
  ]
  for (const d of dirs) for (const n of names) { const p = path.join(d,n); try { if (fs.existsSync(p)) return p } catch {} }
  return null
}

function serializeError(err:any){ if(!err) return null; return { message: err.message||String(err), name: err.name, code: err.code, stack: process.env.DEBUG_RENDER==='1'?err.stack:undefined } }

let fontConfigReady = false
function prepareFontConfig() {
  if (fontConfigReady) return
  try {
    const candidate = [
      path.join(LO_EXTRACT_ROOT,'instdir','share','fonts'),
      '/opt/libreoffice/share/fonts','/opt/fonts','/usr/share/fonts'
    ].filter(d=>{ try { return fs.existsSync(d) } catch { return false } })
    const fontConfigDir = '/tmp/fontconfig'
    const cacheDir = '/tmp/fontconfig-cache'
    fs.mkdirSync(fontConfigDir,{recursive:true}); fs.mkdirSync(cacheDir,{recursive:true}); fs.mkdirSync('/tmp/fonts',{recursive:true})
    const confPath = path.join(fontConfigDir,'fonts.conf')
    const xml = `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n  ${candidate.map(d=>`<dir>${d}</dir>`).join('\n  ')}\n  <dir>/tmp/fonts</dir>\n  <cachedir>${cacheDir}</cachedir>\n  <config></config>\n</fontconfig>`
    fs.writeFileSync(confPath, xml)
    process.env.FONTCONFIG_PATH = fontConfigDir
    process.env.FONTCONFIG_FILE = confPath
    process.env.XDG_CACHE_HOME = '/tmp'
    process.env.XDG_CONFIG_HOME = '/tmp'
    process.env.HOME = process.env.HOME || '/tmp'
    fontConfigReady = true
    log('info','Fontconfig prepared',{ confPath, dirs: candidate, cacheDir })
  } catch (e:any) { log('warn','Fontconfig preparation failed',{ error: e.message }) }
}

async function renderPdf(data: Record<string, any>): Promise<Buffer> {
  if (process.env.SKIP_CONVERT === '1') {
    const pdf = `%PDF-1.4\n1 0 obj<<>>endobj\n2 0 obj<< /Type /Page /Parent 3 0 R /MediaBox[0 0 200 200] /Contents 4 0 R >>endobj\n3 0 obj<< /Type /Pages /Kids[2 0 R] /Count 1 >>endobj\n4 0 obj<< /Length 44 >>stream\nBT /F1 12 Tf 10 100 Td (Local Test PDF) Tj ET\nendstream endobj\n5 0 obj<< /Type /Catalog /Pages 3 0 R >>endobj\nxref\n0 6\n0000000000 65535 f \n0000000010 00000 n \n0000000053 00000 n \n0000000124 00000 n \n0000000179 00000 n \n0000000293 00000 n \ntrailer<< /Size 6 /Root 5 0 R >>\nstartxref\n352\n%%EOF`
    return Buffer.from(pdf,'utf8')
  }
  prepareFontConfig()
  const sofficePath = findSofficeBinary()
  if (!sofficePath) log('warn','Soffice binary not found before Carbone attempt',{ PATH: process.env.PATH })
  if (process.env.ALWAYS_SOFFICE === '1') return fallbackSofficePath(data, sofficePath)

  let primaryError: any = null
  try { return await carboneToBuf(data, { convertTo: 'pdf' }) }
  catch (e:any) {
    primaryError = e
    if (e?.code === 'ENOENT') log('warn','Primary carbone pdf failed ENOENT',{ error: serializeError(e), PATH: process.env.PATH })
    else log('warn','Primary carbone pdf failed',{ error: serializeError(e) })
  }
  try {
    const alt = await carboneToBuf(data, { convertTo: 'pdf:writer_pdf_Export' })
    log('info','Alternate carbone writer_pdf_Export succeeded')
    return alt
  } catch (e2:any) {
    if (!primaryError) primaryError = e2
    log('warn','Alternate carbone writer_pdf_Export failed',{ error: serializeError(e2), PATH: process.env.PATH })
  }
  return fallbackSofficePath(data, sofficePath, primaryError)
}
function carboneToBuf(data: Record<string,any>, opts: any): Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    carbone.render(TEMPLATE_PATH, data, opts, (err, res) => {
      if (err) return reject(err)
      if (!res) return reject(new Error('No result from Carbone'))
      resolve(res as unknown as Buffer)
    })
  })
}
async function fallbackSofficePath(data: Record<string, any>, sofficePath: string | null, primaryError?: any): Promise<Buffer> {
  if (!sofficePath) throw primaryError || new Error('Fallback requested but soffice binary not found')
  let docx: Buffer
  try {
    docx = await carboneToBuf(data, {})
    log('info','DOCX generated for fallback',{ size: docx.length })
  } catch (e:any) {
    log('error','DOCX generation failed for fallback',{ error: serializeError(e) })
    throw primaryError || e
  }
  const ts = Date.now()
  const base = `carbone-${ts}-${Math.random().toString(36).slice(2)}`
  const inputPath = path.join('/tmp', `${base}.docx`)
  const outDir = '/tmp'
  fs.writeFileSync(inputPath, docx)
  const profileDir = '/tmp/lo-profile'
  fs.mkdirSync(profileDir,{ recursive:true })
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
    const start = Date.now()
    try {
      const { stdout, stderr } = await execFileAsync(sofficePath, args, { env: { ...process.env, HOME: '/tmp', FONTCONFIG_PATH: process.env.FONTCONFIG_PATH, FONTCONFIG_FILE: process.env.FONTCONFIG_FILE }, timeout: 45000 })
      log('info','Fallback soffice conversion executed',{ filter: attempt.filter, ms: Date.now()-start, stdout: process.env.DEBUG_RENDER==='1'?stdout:undefined, stderr: process.env.DEBUG_RENDER==='1'?stderr:undefined })
      const pdfPath = inputPath.replace(/\.docx$/i,'.pdf')
      if (!fs.existsSync(pdfPath)) throw new Error('PDF output missing after soffice conversion')
      const pdf = fs.readFileSync(pdfPath)
      try { fs.unlinkSync(inputPath) } catch {}
      try { fs.unlinkSync(pdfPath) } catch {}
      return pdf
    } catch (err:any) {
      lastErr = err
      log('warn','Fallback soffice attempt failed',{ filter: attempt.filter, error: serializeError(err) })
    }
  }
  try { fs.unlinkSync(inputPath) } catch {}
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
    log('info','Rendering start',{ requestId, defaultUsed })
    const pdf = await renderPdf(data)
    const durationMs = Date.now() - start
    log('info','Rendering success',{ requestId, durationMs, size: pdf.length, defaultUsed })
    return { statusCode: 200, isBase64Encoded: true, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="generated.pdf"' }, body: pdf.toString('base64') }
  } catch (e:any) {
    const statusCode = e?.statusCode && Number.isInteger(e.statusCode) ? e.statusCode : 500
    log('error','Rendering failed',{ requestId, statusCode, error: e?.message, stack: process.env.DEBUG_RENDER==='1'?e?.stack:undefined })
    return { statusCode, isBase64Encoded: false, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: e?.message || 'Internal Server Error' }) }
  }
}
