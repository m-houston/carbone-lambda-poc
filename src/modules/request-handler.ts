/**
 * Request parsing and response handling for the Lambda function
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda'
import { createHttpError } from '../utils/logger.js'
import { isLibreOfficeReady } from './libreoffice.js'
import { validateTemplate } from './conversion.js'
import path from 'node:path'
import fs from 'node:fs'

// ---------------- Authentication ----------------
export function validateAuth(event: APIGatewayProxyEventV2): boolean {
  const expectedPassword = process.env.BASIC_AUTH_PASSWORD
  if (!expectedPassword) return true
  const queryPassword = event.queryStringParameters?.password
  if (queryPassword === expectedPassword) return true

  if (event.body && event.requestContext.http.method === 'POST') {
    try {
      const contentType = event.headers?.['content-type'] || event.headers?.['Content-Type'] || ''
      if (contentType.includes('application/x-www-form-urlencoded')) {
        let bodyText = event.body
        if (event.isBase64Encoded) bodyText = Buffer.from(event.body, 'base64').toString('utf-8')
        const formData = new URLSearchParams(bodyText)
        if (formData.get('password') === expectedPassword) return true
      }
    } catch {}
  }
  const authHeader = event.headers?.authorization || event.headers?.Authorization
  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8')
      const [, password] = decoded.split(':')
      if (password === expectedPassword) return true
    } catch {}
  }
  return false
}

export function createAuthChallengeResponse(): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode: 401,
    isBase64Encoded: false,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({
      error: 'Authentication required',
      statusCode: 401,
      message: 'Add ?password=YOUR_PASSWORD to the URL to access this service'
    })
  }
}

// ---------------- Types / defaults ----------------
export interface ParseResult { data: Record<string, any>; defaultUsed: boolean; templateName?: string }

export function buildDefaultData(): Record<string, any> {
  return {
    example: 'default-render',
    generatedAt: new Date().toISOString(),
    fullName: 'John Smith',
    firstName: 'John',
    lastName: 'Smith',
    nhsNumber: '9990000000',
    address_line_1: 'Mr John Smith',
    address_line_2: '221B Baker Street',
    address_line_3: 'London',
    address_line_4: 'NW1 6XE',
    address_line_5: 'United Kingdom',
    address_line_6: '',
    address_line_7: ''
  }
}

// ---------------- Body parsing ----------------
export function parseRequestBody(event: APIGatewayProxyEventV2): ParseResult {
  const method = (event as any).requestContext?.http?.method || 'POST'
  if (method === 'GET') return { data: {}, defaultUsed: false, templateName: event.queryStringParameters?.template || undefined }
  const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))
  const contentType = headers['content-type'] || ''
  if (!event.body || event.body.trim() === '') {
    return { data: buildDefaultData(), defaultUsed: true, templateName: event.queryStringParameters?.template || undefined }
  }
  let rawBody = event.body
  if (event.isBase64Encoded) rawBody = Buffer.from(rawBody, 'base64').toString('utf8')
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return parseFormData(rawBody, event.queryStringParameters?.template)
  }
  return parseJsonData(rawBody)
}

function parseFormData(rawBody: string, templateNameFromQuery?: string): ParseResult {
  try {
    const params = new URLSearchParams(rawBody)
    const dataJson = params.get('dataJson')
    const templateFromForm = params.get('template') || undefined
    let data: any
    if (dataJson) {
      try {
        const parsed = JSON.parse(dataJson)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          data = (parsed as any).data && typeof (parsed as any).data === 'object' ? (parsed as any).data : parsed
        } else {
          data = buildDefaultData()
        }
      } catch { data = buildDefaultData() }
    } else { data = buildDefaultData() }
    return { data, defaultUsed: !dataJson, templateName: templateFromForm || templateNameFromQuery }
  } catch (e) {
    return { data: buildDefaultData(), defaultUsed: true, templateName: templateNameFromQuery }
  }
}

function parseJsonData(rawBody: string): ParseResult {
  try {
    const parsed = JSON.parse(rawBody)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw createHttpError('Body must be a JSON object', 400)
    let data = (parsed as any).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) data = parsed
    return { data, defaultUsed: false, templateName: (parsed as any).template || undefined }
  } catch (e: any) {
    throw createHttpError('Invalid JSON body: ' + e.message, 400)
  }
}

// ---------------- Asset helpers ----------------
function getClientJs(): string {
  const candidates = [
    path.join(__dirname, 'client-app.js'),
    path.join(process.cwd(), 'client-app.js'),
    path.join(__dirname, '..', 'client-app.js')
  ]
  for (const c of candidates) { try { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8') } catch {} }
  return '// client script missing'
}

function getHtmlTemplate(): string {
  const candidates = [
    path.join(__dirname, 'input-form.html'),
    path.join(process.cwd(), 'input-form.html'),
    path.join(__dirname, '..', 'input-form.html')
  ]
  for (const c of candidates) { try { if (fs.existsSync(c)) return fs.readFileSync(c, 'utf8') } catch {} }
  return '<html><body><h1>Input form template missing</h1></html>'
}

// ---------------- Responses ----------------
export function createInputFormResponse(): APIGatewayProxyStructuredResultV2 {
  const htmlRaw = getHtmlTemplate()
  const builtAt = process.env.BUILT_AT || new Date().toISOString()
  const nodeVersion = process.version
  const isTemplateValid = validateTemplate() ? 'true' : 'false'
  const isLoReady = isLibreOfficeReady() ? 'true' : 'false'
  const clientJs = getClientJs()
  const html = htmlRaw
    .replace(/__BUILT_AT__/g, builtAt)
    .replace(/__NODE_VERSION__/g, nodeVersion)
    .replace(/__IS_TEMPLATE_VALID__/g, isTemplateValid)
    .replace(/__IS_LO_READY__/g, isLoReady)
    .replace(/\/\*CLIENT_JS\*\//, clientJs.replace(/<\/script>/g, '<\\/script>'))
  return { statusCode: 200, isBase64Encoded: false, headers: { 'Content-Type': 'text/html; charset=UTF-8' }, body: html }
}

export function createPdfResponse(pdf: Buffer): APIGatewayProxyStructuredResultV2 {
  return { statusCode: 200, isBase64Encoded: true, headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="render.pdf"' }, body: pdf.toString('base64') }
}

export function createErrorResponse(error: any, statusCode = 500): APIGatewayProxyStructuredResultV2 {
  const payload = { error: error?.name || 'Error', message: error?.message || 'Unexpected error', statusCode, stack: process.env.DEBUG_RENDER === '1' ? error?.stack : undefined }
  return { statusCode, isBase64Encoded: false, headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify(payload) }
}

export function isGetRequest(event: APIGatewayProxyEventV2): boolean {
  return (event as any).requestContext?.http?.method === 'GET'
}